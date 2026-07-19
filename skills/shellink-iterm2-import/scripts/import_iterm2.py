#!/usr/bin/env python3
"""Scan local iTerm2 profiles and import them through the Shellink CLI."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import plistlib
import shlex
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


DEFAULT_IDENTITY_NAMES = (
    "id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_dsa",
)
SSH_OPTIONS_WITH_ARGUMENT = {
    "-o", "-J", "-F", "-L", "-R", "-D", "-W", "-b", "-c", "-e", "-m", "-E",
    "-S", "-B", "-w", "-l", "-p", "-i",
}


@dataclass
class Candidate:
    guid: str | None
    name: str
    command: str
    tags: list[str]
    importable: bool
    reason: str | None
    connect_type: str | None
    host: str | None
    port: int | None
    username: str | None
    auth_type: str | None
    key_path: str | None
    term: str
    cols: int
    rows: int

    def display(self) -> dict[str, Any]:
        result = asdict(self)
        result.pop("key_path", None)
        return result


def clamp(value: int, minimum: int, maximum: int) -> int:
    return min(maximum, max(minimum, value))


def parse_ssh_command(command: str) -> dict[str, Any] | None:
    """Parse common ssh invocations while ignoring options and remote commands."""
    try:
        tokens = shlex.split(command.strip())
    except ValueError:
        return None
    if not tokens or tokens[0] != "ssh":
        return None

    host = None
    port = 22
    username = None
    key_path = None
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            continue
        if token == "-p" and index + 1 < len(tokens):
            try:
                port = int(tokens[index + 1])
            except ValueError:
                return None
            index += 2
            continue
        if token == "-l" and index + 1 < len(tokens):
            username = tokens[index + 1]
            index += 2
            continue
        if token == "-i" and index + 1 < len(tokens):
            key_path = tokens[index + 1]
            index += 2
            continue
        if token.startswith("-"):
            index += 2 if token in SSH_OPTIONS_WITH_ARGUMENT else 1
            continue
        if host is not None:
            break

        uri = token.removeprefix("ssh://") if token.startswith("ssh://") else None
        if uri is not None:
            if "@" in uri:
                username, uri = uri.rsplit("@", 1)
            if ":" in uri:
                uri_host, uri_port = uri.rsplit(":", 1)
                if not uri_port.isdigit():
                    return None
                host = uri_host
                port = int(uri_port)
            else:
                host = uri
        elif "@" in token:
            username, host = token.rsplit("@", 1)
        else:
            host = token
        index += 1

    if not host or not 1 <= port <= 65535:
        return None
    return {"host": host, "port": port, "username": username, "key_path": key_path}


def read_private_key(path: Path) -> str | None:
    try:
        content = path.expanduser().read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    return content if "PRIVATE KEY" in content else None


def resolve_private_key(host: str, username: str | None, explicit_path: str | None) -> tuple[str, str] | None:
    candidates: list[str] = []
    if explicit_path:
        candidates.append(explicit_path)
    target = f"{username}@{host}" if username else host
    try:
        result = subprocess.run(
            ["ssh", "-G", target], check=False, capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0].lower() == "identityfile":
                candidates.append(parts[1].strip())
    except (OSError, subprocess.SubprocessError):
        pass

    candidates.extend(str(Path.home() / ".ssh" / name) for name in DEFAULT_IDENTITY_NAMES)
    seen: set[Path] = set()
    for raw_path in candidates:
        path = Path(raw_path).expanduser().resolve()
        if path in seen:
            continue
        seen.add(path)
        content = read_private_key(path)
        if content:
            return content, str(path)
    return None


def raw_bookmarks(home: Path) -> list[dict[str, Any]]:
    plist_path = home / "Library/Preferences/com.googlecode.iterm2.plist"
    if not plist_path.exists():
        return []
    with plist_path.open("rb") as handle:
        data = plistlib.load(handle)
    bookmarks = data.get("New Bookmarks", []) if isinstance(data, dict) else []
    return [item for item in bookmarks if isinstance(item, dict)]


def raw_dynamic_profiles(home: Path) -> list[dict[str, Any]]:
    directory = home / "Library/Application Support/iTerm2/DynamicProfiles"
    if not directory.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for path in sorted(directory.iterdir()):
        if not path.is_file():
            continue
        try:
            if path.suffix.lower() == ".json":
                data = json.loads(path.read_text(encoding="utf-8"))
            else:
                with path.open("rb") as handle:
                    data = plistlib.load(handle)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, plistlib.InvalidFileException):
            continue
        profiles = data.get("Profiles", []) if isinstance(data, dict) else []
        result.extend(item for item in profiles if isinstance(item, dict))
    return result


def to_candidate(bookmark: dict[str, Any], username_fallback: str | None = None) -> Candidate:
    custom_command = bookmark.get("Custom Command") == "Yes"
    command = str(bookmark.get("Command", "")).strip() if custom_command else ""
    candidate = Candidate(
        guid=str(bookmark["Guid"]) if isinstance(bookmark.get("Guid"), str) else None,
        name=str(bookmark.get("Name", "")).strip() or "(unnamed)",
        command=command,
        tags=[str(tag) for tag in bookmark.get("Tags", [])] if isinstance(bookmark.get("Tags"), list) else [],
        importable=bool(command),
        reason=None if command else "Local Shell profile has no remote connection command",
        connect_type=None,
        host=None,
        port=None,
        username=None,
        auth_type=None,
        key_path=None,
        term=str(bookmark.get("Terminal Type") or "xterm-256color"),
        cols=clamp(int(bookmark.get("Columns") or 160), 20, 500),
        rows=clamp(int(bookmark.get("Rows") or 42), 5, 200),
    )
    if not command:
        return candidate

    parsed = parse_ssh_command(command)
    if parsed is None:
        candidate.connect_type = "command"
        return candidate

    username = parsed["username"] or username_fallback or getpass.getuser()
    resolved = resolve_private_key(parsed["host"], username, parsed["key_path"])
    candidate.connect_type = "ssh"
    candidate.host = parsed["host"]
    candidate.port = parsed["port"]
    candidate.username = username
    candidate.auth_type = "key" if resolved else "password"
    candidate.key_path = resolved[1] if resolved else None
    return candidate


def scan_candidates(home: Path | None = None) -> list[Candidate]:
    home = home or Path.home()
    seen: set[str] = set()
    candidates: list[Candidate] = []
    for bookmark in raw_bookmarks(home) + raw_dynamic_profiles(home):
        candidate = to_candidate(bookmark)
        if candidate.guid and candidate.guid in seen:
            continue
        if candidate.guid:
            seen.add(candidate.guid)
        candidates.append(candidate)
    return candidates


def cli_request(executable: str, arguments: list[str], payload: Any = None) -> Any:
    command = [executable, *arguments, "--json"]
    stdin_data = None
    tmp_file = None
    try:
        if payload is not None:
            # Replace "-" in arguments with a temp file path
            tmp_file = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
            json.dump(payload, tmp_file)
            tmp_file.close()
            command = [executable, *[a if a != "-" else tmp_file.name for a in arguments], "--json"]
        result = subprocess.run(
            command, input=stdin_data,
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Cannot run Shellink CLI: {error}") from error
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"Shellink exited {result.returncode}")
    return json.loads(result.stdout)


def profile_body(candidate: Candidate) -> dict[str, Any]:
    if candidate.connect_type == "command":
        body: dict[str, Any] = {
            "name": candidate.name, "connectType": "command", "command": candidate.command,
            "term": candidate.term, "cols": candidate.cols, "rows": candidate.rows,
        }
    else:
        body = {
            "name": candidate.name, "connectType": "ssh", "host": candidate.host,
            "port": candidate.port, "username": candidate.username,
            "authType": candidate.auth_type or "password", "term": candidate.term,
            "cols": candidate.cols, "rows": candidate.rows,
        }
        if candidate.key_path:
            private_key = read_private_key(Path(candidate.key_path))
            if private_key:
                body["privateKey"] = private_key
    if candidate.guid:
        body["uniqueId"] = candidate.guid
    return body


def find_existing(candidate: Candidate, profiles: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Match a previously imported profile by uniqueId, falling back to name.

    iTerm2 ``Guid`` is stored as Shellink ``uniqueId`` so re-imports still match
    after the display name changes. Profiles imported before ``uniqueId`` existed
    are matched by exact ``name`` (and then backfilled with the Guid on update).
    """
    if candidate.guid:
        for profile in profiles:
            if profile.get("uniqueId") == candidate.guid:
                return profile
    for profile in profiles:
        if profile.get("name") == candidate.name:
            return profile
    return None


def import_candidates(args: argparse.Namespace, candidates: list[Candidate]) -> int:
    selected = candidates
    if args.guids:
        selected = [candidate for candidate in candidates if candidate.guid in args.guids]
        missing = sorted(set(args.guids) - {candidate.guid for candidate in selected})
        for guid in missing:
            print(f"SKIP {guid}: profile not found")
    elif args.names:
        selected = [candidate for candidate in candidates if candidate.name in args.names]
    elif not args.all:
        print(json.dumps([candidate.display() for candidate in candidates], ensure_ascii=False, indent=2))
        print("Pass --all, --guid, or --name to import selected profiles.", file=sys.stderr)
        return 0

    if args.dry_run:
        print(json.dumps([candidate.display() for candidate in selected], ensure_ascii=False, indent=2))
        return 0

    profiles = cli_request(args.shellink, ["profile", "list"])
    imported = 0
    updated = 0
    skipped = 0
    for candidate in selected:
        if not candidate.importable or not candidate.connect_type:
            print(f"SKIP {candidate.name}: {candidate.reason or 'cannot parse connection'}")
            skipped += 1
            continue
        existing = find_existing(candidate, profiles) if args.on_existing != "create" else None
        if existing and args.on_existing == "skip":
            print(f"SKIP {candidate.name}: already exists ({existing.get('id', 'existing profile')})")
            skipped += 1
            continue
        try:
            if existing:
                result = cli_request(
                    args.shellink, ["profile", "update", existing["id"], "--input", "-"], profile_body(candidate)
                )
                profiles[profiles.index(existing)] = result
                updated += 1
                print(f"UPDATED {candidate.name}")
            else:
                result = cli_request(
                    args.shellink, ["profile", "create", "--input", "-"], profile_body(candidate)
                )
                profiles.append(result)
                imported += 1
                print(f"IMPORTED {candidate.name}")
        except RuntimeError as error:
            print(f"FAIL {candidate.name}: {error}", file=sys.stderr)
            skipped += 1
            continue
    print(f"Imported {imported}; updated {updated}; skipped {skipped}.")
    return 0 if skipped == 0 else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shellink", default=os.environ.get("SHELLINK_CLI", "shellink"))
    parser.add_argument("--all", action="store_true", help="import all importable profiles")
    parser.add_argument("--guid", dest="guids", action="append", default=[], help="import a profile by Guid")
    parser.add_argument("--name", dest="names", action="append", default=[], help="import a profile by exact name")
    parser.add_argument(
        "--on-existing", choices=("update", "skip", "create"), default="update",
        help="when a profile with the same uniqueId or name exists: update it (default), skip it, or always create a new one",
    )
    parser.add_argument("--dry-run", action="store_true", help="scan and select without calling the API")
    parser.add_argument("--json", action="store_true", help="print all scanned profiles as JSON and exit")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if sys.platform != "darwin":
        print("iTerm2 import is supported on macOS only.", file=sys.stderr)
        return 1
    candidates = scan_candidates()
    if args.json:
        print(json.dumps([candidate.display() for candidate in candidates], ensure_ascii=False, indent=2))
        return 0
    return import_candidates(args, candidates)


if __name__ == "__main__":
    raise SystemExit(main())
