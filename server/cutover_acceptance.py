#!/usr/bin/env python3

import argparse
import json
import re
import ssl
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlencode, urlparse

from server.protocol_smoke import SniHttpsConnection
from server.setup_production import write_private


JsonRequest = Callable[
    [str, str, str, str, Optional[dict[str, Any]], Optional[Path], Optional[str]],
    tuple[int, dict[str, Any]],
]


def validate_endpoint(endpoint: str) -> str:
    normalized = endpoint.strip().rstrip("/")
    parsed = urlparse(normalized)
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
    return normalized


def valid_max_age(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("max age must be an integer") from error
    if not 30 <= parsed <= 3600:
        raise argparse.ArgumentTypeError(
            "max age must be between 30 and 3600 seconds"
        )
    return parsed


def read_private_token(path: Path) -> str:
    if not path.is_file():
        raise ValueError("API token file does not exist")
    if path.stat().st_mode & 0o077:
        raise ValueError("API token file must not be group/world accessible")
    token = path.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("API token file has an invalid format")
    return token


def request_json(
    endpoint: str,
    method: str,
    path: str,
    token: str,
    value: Optional[dict[str, Any]] = None,
    ca_file: Optional[Path] = None,
    connect_host: Optional[str] = None,
) -> tuple[int, dict[str, Any]]:
    parsed = urlparse(validate_endpoint(endpoint))
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
    body = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if value is not None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    host_header = parsed.hostname
    if parsed.port is not None and parsed.port != 443:
        host_header = f"{host_header}:{parsed.port}"
    headers["Host"] = host_header
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read(1_048_576)
    finally:
        connection.close()
    try:
        decoded = json.loads(response_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("gateway returned invalid JSON") from error
    if not isinstance(decoded, dict):
        raise RuntimeError("gateway returned a non-object response")
    return response.status, decoded


def capture_baseline(
    endpoint: str,
    token: str,
    ca_file: Optional[Path] = None,
    connect_host: Optional[str] = None,
    request: JsonRequest = request_json,
) -> dict[str, Any]:
    slots = {}
    for slot_index in (0, 1):
        query = urlencode({"slotIndex": slot_index, "limit": 1})
        status, response = request(
            endpoint,
            "GET",
            f"/v1/messages?{query}",
            token,
            None,
            ca_file,
            connect_host,
        )
        if status != 200:
            raise RuntimeError(
                f"message baseline failed for SIM{slot_index + 1}: HTTP {status}"
            )
        messages = response.get("messages")
        if not isinstance(messages, list):
            raise RuntimeError("message API response is missing messages")
        latest_id = 0
        if messages:
            candidate = messages[0]
            if (
                not isinstance(candidate, dict)
                or not isinstance(candidate.get("id"), int)
                or candidate["id"] < 1
            ):
                raise RuntimeError("message API returned an invalid event ID")
            latest_id = candidate["id"]
        slots[str(slot_index)] = latest_id
    return {
        "schemaVersion": 1,
        "endpoint": validate_endpoint(endpoint),
        "capturedAt": int(time.time() * 1000),
        "slots": slots,
    }


def verify_slot(
    endpoint: str,
    token: str,
    baseline: dict[str, Any],
    slot_index: int,
    max_age_seconds: int = 600,
    ca_file: Optional[Path] = None,
    connect_host: Optional[str] = None,
    request: JsonRequest = request_json,
) -> dict[str, Any]:
    if slot_index not in (0, 1):
        raise ValueError("slot index must be 0 or 1")
    if not 30 <= max_age_seconds <= 3600:
        raise ValueError("max age must be between 30 and 3600 seconds")
    normalized_endpoint = validate_endpoint(endpoint)
    if (
        baseline.get("schemaVersion") != 1
        or baseline.get("endpoint") != normalized_endpoint
        or not isinstance(baseline.get("slots"), dict)
    ):
        raise ValueError("baseline does not match this gateway endpoint")
    after_id = baseline["slots"].get(str(slot_index))
    if not isinstance(after_id, int) or after_id < 0:
        raise ValueError("baseline has an invalid slot event ID")
    query = urlencode(
        {
            "slotIndex": slot_index,
            "afterId": after_id,
            "limit": 100,
        }
    )
    status, response = request(
        normalized_endpoint,
        "GET",
        f"/v1/messages?{query}",
        token,
        None,
        ca_file,
        connect_host,
    )
    if status != 200:
        raise RuntimeError(
            f"new-message check failed for SIM{slot_index + 1}: HTTP {status}"
        )
    messages = response.get("messages")
    if not isinstance(messages, list):
        raise RuntimeError("message API response is missing messages")
    eligible = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        event_id = message.get("id")
        candidates = message.get("otpCandidates")
        if (
            isinstance(event_id, int)
            and event_id > after_id
            and message.get("slotIndex") == slot_index
            and isinstance(candidates, list)
            and candidates
            and all(
                isinstance(candidate, str)
                and re.fullmatch(r"[0-9]{4,8}", candidate)
                for candidate in candidates
            )
        ):
            eligible.append(message)
    if not eligible:
        raise RuntimeError(
            f"no new OTP-bearing message found for SIM{slot_index + 1}"
        )
    selected = max(eligible, key=lambda message: message["id"])
    event_id = selected["id"]
    claim_request = {
        "slotIndex": slot_index,
        "maxAgeSeconds": max_age_seconds,
        "eventId": event_id,
    }
    status, claimed = request(
        normalized_endpoint,
        "POST",
        "/v1/otp/claim",
        token,
        claim_request,
        ca_file,
        connect_host,
    )
    if status != 200:
        raise RuntimeError(
            f"exact OTP claim failed for SIM{slot_index + 1}: HTTP {status}"
        )
    otp = claimed.get("otp")
    if (
        not isinstance(otp, dict)
        or otp.get("eventId") != event_id
        or otp.get("slotIndex") != slot_index
        or otp.get("code") not in selected["otpCandidates"]
    ):
        raise RuntimeError("OTP claim does not match the selected message")
    second_status, _ = request(
        normalized_endpoint,
        "POST",
        "/v1/otp/claim",
        token,
        claim_request,
        ca_file,
        connect_host,
    )
    if second_status != 404:
        raise RuntimeError(
            "the same OTP event was claimable more than once"
        )
    return {
        "slotIndex": slot_index,
        "eventId": event_id,
        "receivedAt": selected.get("receivedAt"),
        "candidateCount": len(selected["otpCandidates"]),
        "secondClaimStatus": second_status,
    }


def load_baseline(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError("baseline file does not exist")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("baseline file must contain a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Verify natural SIM SMS/OTP delivery without printing sender, "
            "message body, token, or OTP value."
        )
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--ca-file", type=Path)
    parser.add_argument("--connect-host")
    subparsers = parser.add_subparsers(dest="command", required=True)
    baseline_parser = subparsers.add_parser(
        "baseline",
        help="Record the latest message ID for each SIM before sending tests.",
    )
    baseline_parser.add_argument("--output", required=True, type=Path)
    verify_parser = subparsers.add_parser(
        "verify",
        help="Verify one new OTP SMS and exact one-time claim for a SIM.",
    )
    verify_parser.add_argument("--baseline", required=True, type=Path)
    verify_parser.add_argument("--slot", required=True, type=int, choices=(0, 1))
    verify_parser.add_argument(
        "--max-age-seconds",
        type=valid_max_age,
        default=600,
        metavar="30..3600",
    )
    args = parser.parse_args()

    endpoint = validate_endpoint(args.url)
    token = read_private_token(args.token_file.resolve())
    ca_file = args.ca_file.resolve() if args.ca_file is not None else None
    if args.command == "baseline":
        baseline = capture_baseline(
            endpoint,
            token,
            ca_file=ca_file,
            connect_host=args.connect_host,
        )
        write_private(
            args.output.resolve(),
            json.dumps(baseline, indent=2) + "\n",
        )
        print(
            "Cutover baseline recorded privately. No message content, sender, "
            "OTP, or API token was printed."
        )
        return 0
    baseline = load_baseline(args.baseline.resolve())
    result = verify_slot(
        endpoint,
        token,
        baseline,
        args.slot,
        max_age_seconds=args.max_age_seconds,
        ca_file=ca_file,
        connect_host=args.connect_host,
    )
    print(
        f"SIM{result['slotIndex'] + 1} natural SMS/OTP and exact one-time "
        "claim: PASS"
    )
    print(
        "Sensitive sender, message body, OTP value, and API token were not "
        "printed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
