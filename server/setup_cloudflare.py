#!/usr/bin/env python3

import argparse
import json
import uuid
from pathlib import Path

try:
    from server.setup_production import valid_domain, write_private
except ModuleNotFoundError:
    from setup_production import valid_domain, write_private


def prepare_cloudflare_runtime(
    domain: str,
    tunnel_id: str,
    credentials_source: Path,
    runtime_dir: Path,
) -> None:
    normalized_domain = valid_domain(domain)
    normalized_tunnel_id = str(uuid.UUID(tunnel_id))
    if not credentials_source.is_file():
        raise ValueError("Cloudflare tunnel credential file does not exist")
    try:
        credentials = json.loads(
            credentials_source.read_text(encoding="utf-8")
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Cloudflare tunnel credential file is invalid") from error
    if (
        not isinstance(credentials, dict)
        or str(credentials.get("TunnelID", "")) != normalized_tunnel_id
        or not isinstance(credentials.get("AccountTag"), str)
        or not credentials["AccountTag"]
        or not isinstance(credentials.get("TunnelSecret"), str)
        or not credentials["TunnelSecret"]
    ):
        raise ValueError(
            "Cloudflare tunnel credential does not match the tunnel ID"
        )
    runtime = runtime_dir.resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)
    write_private(
        runtime / "cloudflare-tunnel-credentials.json",
        json.dumps(credentials, separators=(",", ":")) + "\n",
    )
    write_private(
        runtime / "cloudflared-config.yml",
        "\n".join(
            (
                f"tunnel: {normalized_tunnel_id}",
                "credentials-file: "
                "/run/secrets/cloudflare_tunnel_credentials",
                "metrics: 0.0.0.0:2000",
                "ingress:",
                f"  - hostname: {normalized_domain}",
                "    service: http://gateway:8787",
                "  - service: http_status:404",
                "",
            )
        ),
    )


def main() -> None:
    root = Path(__file__).resolve().parent / "deploy" / "runtime"
    parser = argparse.ArgumentParser(
        description=(
            "Prepare private config-file-managed Cloudflare Tunnel runtime "
            "files without printing tunnel credentials."
        )
    )
    parser.add_argument("--domain", required=True)
    parser.add_argument("--tunnel-id", required=True)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--runtime-dir", type=Path, default=root)
    args = parser.parse_args()
    prepare_cloudflare_runtime(
        args.domain,
        args.tunnel_id,
        args.credentials_file.resolve(),
        args.runtime_dir,
    )
    print(f"Prepared Cloudflare Tunnel runtime for: {valid_domain(args.domain)}")
    print("Tunnel credentials were copied to a private runtime file.")
    print("No tunnel credential value was printed.")


if __name__ == "__main__":
    main()
