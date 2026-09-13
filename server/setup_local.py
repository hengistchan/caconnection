#!/usr/bin/env python3

import argparse
import base64
import json
import os
import socket
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def detect_lan_ip() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]


def ensure_certificate(
    root: Path, lan_ip: str, rotate: bool = False
) -> tuple[Path, Path, str]:
    tls = root / "tls"
    tls.mkdir(parents=True, exist_ok=True)
    certificate_path = tls / "receiver-cert.pem"
    key_path = tls / "receiver-key.pem"
    if certificate_path.exists() != key_path.exists():
        raise ValueError(
            "TLS certificate/key pair is incomplete; restore it or rotate explicitly"
        )
    if certificate_path.exists() and not rotate:
        certificate = x509.load_pem_x509_certificate(certificate_path.read_bytes())
        now = datetime.now(timezone.utc)
        if hasattr(certificate, "not_valid_after_utc"):
            not_after = certificate.not_valid_after_utc
        else:
            not_after = certificate.not_valid_after.replace(tzinfo=timezone.utc)
        try:
            names = certificate.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
        except x509.ExtensionNotFound as error:
            raise ValueError(
                "Existing TLS certificate has no subject alternative names; "
                "rotate it explicitly"
            ) from error
        if now >= not_after or ip_address(lan_ip) not in names.get_values_for_type(
            x509.IPAddress
        ):
            raise ValueError(
                "Existing TLS certificate is expired or does not cover the LAN IP; "
                "rerun with --rotate-certificate and update the Android pin"
            )
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "CA Connection Local Receiver")]
        )
        now = datetime.now(timezone.utc)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=365))
            .add_extension(
                x509.SubjectAlternativeName(
                    [
                        x509.IPAddress(ip_address(lan_ip)),
                        x509.IPAddress(ip_address("127.0.0.1")),
                        x509.DNSName("localhost"),
                    ]
                ),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        certificate_path.write_bytes(
            certificate.public_bytes(serialization.Encoding.PEM)
        )
        key_path.chmod(0o600)
        certificate_path.chmod(0o600)
    pin = base64.b64encode(certificate.fingerprint(hashes.SHA256())).decode("ascii")
    return certificate_path, key_path, pin


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare ignored local receiver credentials and TLS files."
    )
    parser.add_argument("--device-id", default="xiaomi-gateway")
    parser.add_argument("--lan-ip", default=None)
    parser.add_argument(
        "--rotate-certificate",
        action="store_true",
        help="Replace the TLS certificate; the Android certificate pin must then be updated.",
    )
    parser.add_argument(
        "--config",
        default=str(Path(__file__).with_name("config.json")),
    )
    args = parser.parse_args()

    path = Path(args.config)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(path.read_text()) if path.exists() else {"devices": {}}
    devices = data.setdefault("devices", {})
    devices.setdefault(
        args.device_id,
        {"secret_base64": base64.b64encode(os.urandom(32)).decode("ascii")},
    )
    lan_ip = args.lan_ip or detect_lan_ip()
    certificate, private_key, pin = ensure_certificate(
        path.parent, lan_ip, rotate=args.rotate_certificate
    )
    data["tls"] = {
        "certificate": str(certificate),
        "private_key": str(private_key),
        "certificate_pin_sha256_base64": pin,
        "lan_ip": lan_ip,
    }
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)
    print(f"Prepared local configuration: {path}")
    print(f"Device ID: {args.device_id}")
    print("Secret was written to the ignored configuration and was not printed.")
    print(f"HTTPS certificate pin: {pin}")


if __name__ == "__main__":
    main()
