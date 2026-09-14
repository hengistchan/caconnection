#!/usr/bin/env python3

import argparse
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"


@dataclass(frozen=True)
class CheckResult:
    status: str
    name: str
    detail: str


class ProductionHostAudit:
    def __init__(
        self,
        domain: str,
        deploy_dir: Path,
        require_runtime: bool = False,
        allow_existing_listeners: bool = False,
        command_runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        command_lookup: Callable[[str], Optional[str]] = shutil.which,
        system_name: Callable[[], str] = platform.system,
        disk_usage: Callable[[str], os.statvfs_result] = shutil.disk_usage,
        address_lookup: Callable[..., list[tuple]] = socket.getaddrinfo,
        url_open: Callable[..., object] = urllib.request.urlopen,
    ):
        self.domain = domain
        self.deploy_dir = deploy_dir
        self.require_runtime = require_runtime
        self.allow_existing_listeners = allow_existing_listeners
        self.command_runner = command_runner
        self.command_lookup = command_lookup
        self.system_name = system_name
        self.disk_usage = disk_usage
        self.address_lookup = address_lookup
        self.url_open = url_open
        self.results: list[CheckResult] = []

    def pass_check(self, name: str, detail: str) -> None:
        self.results.append(CheckResult("PASS", name, detail))

    def warn(self, name: str, detail: str) -> None:
        self.results.append(CheckResult("WARN", name, detail))

    def fail(self, name: str, detail: str) -> None:
        self.results.append(CheckResult("FAIL", name, detail))

    def run_command(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        return self.command_runner(
            command,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    def audit(self) -> list[CheckResult]:
        self.check_operating_system()
        self.check_disk_space()
        self.check_docker()
        self.check_clock()
        self.check_port_listeners()
        self.check_dns()
        self.check_acme_reachability()
        self.check_firewall_visibility()
        self.check_runtime_files()
        return self.results

    def check_operating_system(self) -> None:
        current = self.system_name()
        if current == "Linux":
            self.pass_check("Operating system", "Linux host detected")
        else:
            self.fail(
                "Operating system",
                f"Production deployment requires Linux; detected {current}",
            )

    def check_disk_space(self) -> None:
        try:
            free = self.disk_usage(str(self.deploy_dir)).free
        except OSError as error:
            self.fail("Disk space", f"Unable to inspect free space: {error}")
            return
        gib = free / (1024**3)
        if free >= MIN_FREE_BYTES:
            self.pass_check("Disk space", f"{gib:.1f} GiB available")
        else:
            self.fail(
                "Disk space",
                f"{gib:.1f} GiB available; at least 2.0 GiB is required",
            )

    def check_docker(self) -> None:
        if self.command_lookup("docker") is None:
            self.fail("Docker Engine", "docker command is not installed")
            self.fail("Docker Compose", "Docker Compose cannot be checked")
            return
        info = self.run_command(
            ["docker", "info", "--format", "{{.ServerVersion}}"]
        )
        if info.returncode == 0 and info.stdout.strip():
            self.pass_check(
                "Docker Engine",
                f"daemon reachable, version {info.stdout.strip()}",
            )
        else:
            self.fail(
                "Docker Engine",
                "docker daemon is unavailable to the current user",
            )
        compose = self.run_command(["docker", "compose", "version", "--short"])
        if compose.returncode == 0 and compose.stdout.strip():
            self.pass_check(
                "Docker Compose",
                f"Compose v2 available, version {compose.stdout.strip()}",
            )
        else:
            self.fail(
                "Docker Compose",
                "docker compose v2 is unavailable",
            )

    def check_clock(self) -> None:
        if self.command_lookup("timedatectl") is None:
            self.warn(
                "Clock synchronization",
                "timedatectl is unavailable; verify NTP synchronization manually",
            )
            return
        result = self.run_command(
            ["timedatectl", "show", "--property=NTPSynchronized", "--value"]
        )
        value = result.stdout.strip().lower()
        if result.returncode == 0 and value == "yes":
            self.pass_check("Clock synchronization", "NTP is synchronized")
        elif result.returncode == 0 and value == "no":
            self.fail(
                "Clock synchronization",
                "NTP is not synchronized; signed requests allow only five minutes of skew",
            )
        else:
            self.warn(
                "Clock synchronization",
                "Unable to determine NTP synchronization state",
            )

    @staticmethod
    def occupied_ports(output: str) -> set[int]:
        ports = set()
        for line in output.splitlines():
            for token in line.split():
                match = re.search(r"\]:(80|443)$|:(80|443)$", token)
                if match:
                    ports.add(int(match.group(1) or match.group(2)))
        return ports

    def check_port_listeners(self) -> None:
        if self.command_lookup("ss") is None:
            self.warn(
                "Public ports",
                "ss is unavailable; verify TCP 80/443 and UDP 443 are free manually",
            )
            return
        occupied = set()
        for command in (["ss", "-H", "-ltn"], ["ss", "-H", "-lun"]):
            result = self.run_command(command)
            if result.returncode != 0:
                self.warn(
                    "Public ports",
                    "Unable to inspect all TCP/UDP listeners",
                )
                return
            occupied.update(self.occupied_ports(result.stdout))
        if occupied and not self.allow_existing_listeners:
            values = ", ".join(str(value) for value in sorted(occupied))
            self.fail(
                "Public ports",
                f"port(s) already in use: {values}; Compose Caddy must bind 80/443",
            )
        elif occupied:
            values = ", ".join(str(value) for value in sorted(occupied))
            self.warn(
                "Public ports",
                f"existing listener(s) allowed for this audit: {values}",
            )
        else:
            self.pass_check("Public ports", "TCP 80/443 and UDP 443 are free")

    def check_dns(self) -> None:
        try:
            entries = self.address_lookup(
                self.domain,
                443,
                type=socket.SOCK_STREAM,
            )
            addresses = sorted({entry[4][0] for entry in entries})
        except OSError as error:
            self.fail("DNS", f"{self.domain} does not resolve: {error}")
            return
        public_addresses = []
        for address in addresses:
            try:
                if ipaddress.ip_address(address).is_global:
                    public_addresses.append(address)
            except ValueError:
                continue
        if public_addresses:
            self.pass_check(
                "DNS",
                f"{self.domain} resolves to {len(public_addresses)} public address(es)",
            )
        else:
            self.fail(
                "DNS",
                f"{self.domain} does not resolve to a public IP address",
            )

    def check_acme_reachability(self) -> None:
        try:
            response = self.url_open(ACME_DIRECTORY, timeout=8)
            status = getattr(response, "status", 200)
            close = getattr(response, "close", None)
            if close is not None:
                close()
            if 200 <= status < 400:
                self.pass_check(
                    "ACME network",
                    "Let's Encrypt directory is reachable over HTTPS",
                )
                return
            raise OSError(f"unexpected HTTP status {status}")
        except Exception as error:
            self.warn(
                "ACME network",
                f"outbound certificate service check failed: {error}",
            )

    def check_firewall_visibility(self) -> None:
        tools = [
            name
            for name in ("ufw", "firewall-cmd", "nft", "iptables")
            if self.command_lookup(name) is not None
        ]
        detail = (
            f"detected {', '.join(tools)}; inbound reachability still requires "
            "an external check"
            if tools
            else "no supported firewall inspection tool detected; verify provider "
            "and host firewall rules manually"
        )
        self.warn("Firewall", detail)

    def check_runtime_files(self) -> None:
        runtime = self.deploy_dir / "runtime"
        env_file = self.deploy_dir / ".env"
        required = [
            env_file,
            runtime / "config.json",
            runtime / "android-provisioning.json",
            runtime / "automation-api-token.txt",
        ]
        missing = [path for path in required if not path.is_file()]
        if missing:
            detail = "production credentials have not been prepared"
            if self.require_runtime:
                self.fail("Runtime credentials", detail)
            else:
                self.warn(
                    "Runtime credentials",
                    detail + "; this is expected before setup_production.py",
                )
            return
        insecure = []
        for path in required:
            if path.stat().st_mode & 0o077:
                insecure.append(path.name)
        if runtime.stat().st_mode & 0o077:
            insecure.append("runtime/")
        if insecure:
            self.fail(
                "Runtime credentials",
                "group/world permissions are present on: "
                + ", ".join(sorted(insecure)),
            )
            return
        try:
            env_lines = [
                line.strip()
                for line in env_file.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            config = json.loads(
                (runtime / "config.json").read_text(encoding="utf-8")
            )
            provisioning = json.loads(
                (runtime / "android-provisioning.json").read_text(
                    encoding="utf-8"
                )
            )
            token = (
                runtime / "automation-api-token.txt"
            ).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            self.fail(
                "Runtime credentials",
                f"private runtime files are unreadable or invalid: {error}",
            )
            return
        valid = (
            env_lines == [f"GATEWAY_DOMAIN={self.domain}"]
            and provisioning.get("endpoint") == f"https://{self.domain}"
            and provisioning.get("enabled") is True
            and isinstance(config.get("devices"), dict)
            and bool(config["devices"])
            and isinstance(config.get("api_clients"), dict)
            and bool(config["api_clients"])
            and bool(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token))
        )
        if valid:
            self.pass_check(
                "Runtime credentials",
                "private files are present, restrictive, and match the domain",
            )
        else:
            self.fail(
                "Runtime credentials",
                "private files are incomplete or do not match the requested domain",
            )


def valid_domain(value: str) -> str:
    normalized = value.strip().lower()
    pattern = re.compile(
        r"(?=^.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}"
        r"[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$"
    )
    if not pattern.fullmatch(normalized):
        raise argparse.ArgumentTypeError("a valid DNS hostname is required")
    return normalized


def main() -> int:
    root = Path(__file__).resolve().parent / "deploy"
    parser = argparse.ArgumentParser(
        description="Read-only audit of a proposed production gateway host."
    )
    parser.add_argument("--domain", required=True, type=valid_domain)
    parser.add_argument("--deploy-dir", type=Path, default=root)
    parser.add_argument("--require-runtime", action="store_true")
    parser.add_argument("--allow-existing-listeners", action="store_true")
    args = parser.parse_args()

    audit = ProductionHostAudit(
        args.domain,
        args.deploy_dir.resolve(),
        require_runtime=args.require_runtime,
        allow_existing_listeners=args.allow_existing_listeners,
    )
    results = audit.audit()
    for result in results:
        print(f"[{result.status}] {result.name}: {result.detail}")
    failures = sum(result.status == "FAIL" for result in results)
    warnings = sum(result.status == "WARN" for result in results)
    print(
        f"Preflight result: {failures} failure(s), {warnings} warning(s), "
        f"{len(results) - failures - warnings} pass(es)"
    )
    if warnings:
        print(
            "Warnings require operator review; inbound firewall reachability "
            "must be verified externally."
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
