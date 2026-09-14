#!/usr/bin/env python3

import argparse
import http.client
import json
import socket
import ssl
import time
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from server.gateway_server import (
    encrypt_payload,
    expected_signature,
    load_devices,
)


class SniHttpsConnection(http.client.HTTPSConnection):
    """Connect to one host while validating TLS for another server name."""

    def __init__(
        self,
        connect_host: str,
        server_name: str,
        port: int,
        context: ssl.SSLContext,
        timeout: float,
    ) -> None:
        super().__init__(
            connect_host,
            port=port,
            context=context,
            timeout=timeout,
        )
        self._server_name = server_name

    def connect(self) -> None:
        sock = socket.create_connection(
            (self.host, self.port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
            sock = self.sock
        self.sock = self._context.wrap_socket(
            sock,
            server_hostname=self._server_name,
        )


def build_smoke_request(
    device_id: str,
    secret: bytes,
    now_ms: Optional[int] = None,
) -> tuple[bytes, dict[str, str]]:
    timestamp_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    unique = uuid.uuid4().hex
    envelope: dict[str, Any] = {
        "schemaVersion": 1,
        "deliveryId": f"production-smoke-{unique}",
        "sourceEventId": f"production-smoke-{unique}",
        "eventType": "LOCAL_SELF_TEST",
        "createdAt": timestamp_ms,
        "subscriptionId": None,
        "slotIndex": None,
        "payload": {
            "type": "LOCAL_SELF_TEST",
            "source": "production-deployment-check",
        },
    }
    encrypted = encrypt_payload(envelope, device_id, secret)
    body = json.dumps(
        encrypted,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    nonce = str(uuid.uuid4())
    idempotency_key = f"production-smoke-{unique}"
    return body, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Gateway-Device": device_id,
        "X-Gateway-Timestamp": str(timestamp_ms),
        "X-Gateway-Nonce": nonce,
        "X-Gateway-Signature": expected_signature(
            secret,
            timestamp_ms,
            nonce,
            device_id,
            idempotency_key,
            body,
        ),
        "Idempotency-Key": idempotency_key,
    }


def run_smoke(
    endpoint: str,
    config_path: Path,
    device_id: Optional[str] = None,
    connect_host: Optional[str] = None,
    ca_file: Optional[Path] = None,
) -> int:
    parsed = urlparse(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise ValueError("endpoint must be an HTTPS origin URL")
    devices = load_devices(config_path)
    selected_device = device_id or next(iter(devices))
    secret = devices.get(selected_device)
    if secret is None:
        raise ValueError("selected device is not configured")

    body, headers = build_smoke_request(selected_device, secret)
    context = ssl.create_default_context(
        cafile=str(ca_file) if ca_file is not None else None
    )
    port = parsed.port or 443
    connection = SniHttpsConnection(
        connect_host or parsed.hostname,
        parsed.hostname,
        port,
        context,
        timeout=10,
    )
    host_header = parsed.hostname
    if parsed.port is not None and parsed.port != 443:
        host_header = f"{host_header}:{parsed.port}"
    headers["Host"] = host_header
    try:
        connection.request("POST", "/v1/events", body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read(16_384)
    finally:
        connection.close()
    if response.status not in (200, 201):
        raise RuntimeError(f"protocol smoke failed with HTTP {response.status}")
    try:
        value = json.loads(response_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("protocol smoke returned invalid JSON") from error
    if not isinstance(value, dict) or value.get("accepted") is not True:
        raise RuntimeError("protocol smoke was not accepted")
    return response.status


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Send one signed encrypted event through the production proxy."
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--device-id")
    parser.add_argument(
        "--connect-host",
        help="TCP destination override; TLS SNI and Host still use --url.",
    )
    parser.add_argument("--ca-file", type=Path)
    args = parser.parse_args()
    status = run_smoke(
        args.url,
        args.config,
        device_id=args.device_id,
        connect_host=args.connect_host,
        ca_file=args.ca_file,
    )
    print(f"Signed encrypted protocol smoke test: PASS (HTTP {status})")


if __name__ == "__main__":
    main()
