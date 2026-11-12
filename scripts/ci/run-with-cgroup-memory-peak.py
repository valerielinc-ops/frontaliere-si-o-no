#!/usr/bin/env python3
"""Run a command while recording its job cgroup's exact memory high-water mark.

Linux cgroup v2 keeps memory.peak in the kernel, so short-lived RSS spikes are
retained even when they happen between userspace sampler ticks. The peak is
measured on the current job cgroup so unrelated sibling processes cannot affect
the result; ancestor memory.max values still set the effective runner limit.
Per-FD reset requires a writable current-job cgroup v2 memory.peak (mainline
Linux 6.12+; vendor backports also work). If the runner user cannot reset it,
the helper retries through non-interactive sudo and runs the measured command
as the original user. Missing or read-only counters are fatal; there is no
sampled-RSS fallback. The counter is reset and read on the same descriptor.
"""

from __future__ import annotations

import argparse
import errno
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

MIB = 1024 * 1024


class MeasurementError(RuntimeError):
    pass


class PrivilegeRequired(MeasurementError):
    pass


def _unescape_mount_path(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def _cgroup_v2_mount() -> tuple[Path, str]:
    cgroup_path = None
    try:
        for line in Path("/proc/self/cgroup").read_text().splitlines():
            if line.startswith("0::"):
                cgroup_path = line[3:]
                break
    except OSError as error:
        raise MeasurementError(f"/proc/self/cgroup non leggibile: {error}") from error
    if not cgroup_path or not cgroup_path.startswith("/") or ".." in Path(cgroup_path).parts:
        raise MeasurementError("percorso cgroup v2 del processo non disponibile o non valido")

    try:
        mountinfo = Path("/proc/self/mountinfo").read_text().splitlines()
    except OSError as error:
        raise MeasurementError(f"/proc/self/mountinfo non leggibile: {error}") from error
    for line in mountinfo:
        fields = line.split()
        try:
            separator = fields.index("-")
        except ValueError:
            continue
        if separator + 1 >= len(fields) or fields[separator + 1] != "cgroup2":
            continue
        mount_root = _unescape_mount_path(fields[3])
        mount_point = Path(_unescape_mount_path(fields[4]))
        if mount_root == "/":
            relative = cgroup_path.lstrip("/")
        elif cgroup_path == mount_root:
            relative = ""
        elif cgroup_path.startswith(mount_root.rstrip("/") + "/"):
            relative = cgroup_path[len(mount_root.rstrip("/")) + 1 :]
        else:
            continue
        group = mount_point / relative
        return group, mount_point.as_posix()
    raise MeasurementError("memory.peak cgroup v2 non disponibile nel cgroup del processo")


def _read_memtotal_bytes() -> int:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                kib = int(line.split()[1])
                if kib > 0:
                    return kib * 1024
    except (OSError, ValueError, IndexError) as error:
        raise MeasurementError(f"MemTotal del runner non misurabile: {error}") from error
    raise MeasurementError("MemTotal del runner non trovato")


def _effective_runner_limit_bytes(group: Path, mount_point: str) -> int:
    host_limit = _read_memtotal_bytes()
    limit_bytes = host_limit
    mount = Path(mount_point)
    current = group
    while True:
        limit_file = current / "memory.max"
        try:
            raw = limit_file.read_text().strip()
        except FileNotFoundError:
            raw = ""
        except OSError as error:
            raise MeasurementError(f"{limit_file} non leggibile: {error}") from error
        if raw and raw != "max":
            try:
                limit = int(raw)
            except ValueError as error:
                raise MeasurementError(f"limite cgroup non valido in {limit_file}: {raw!r}") from error
            if limit <= 0:
                raise MeasurementError(f"limite cgroup non positivo in {limit_file}: {limit}")
            if limit < limit_bytes:
                limit_bytes = limit
        if current == mount:
            break
        parent = current.parent
        if parent == current or os.path.commonpath((mount, parent)) != str(mount):
            break
        current = parent
    return limit_bytes


def _current_memory_bytes(group: Path) -> int:
    current_file = group / "memory.current"
    try:
        raw = current_file.read_text().strip()
        current = int(raw)
    except (OSError, ValueError) as error:
        raise MeasurementError(f"{current_file} non leggibile o non valido: {error}") from error
    if current <= 0:
        raise MeasurementError(f"memoria cgroup corrente non positiva in {current_file}: {current}")
    return current


def _measure_command(
    group: Path,
    limit_bytes: int,
    command: list[str],
    drop_to: tuple[int, int, str] | None,
) -> int:
    peak_file = group / "memory.peak"
    baseline_bytes = _current_memory_bytes(group)
    try:
        peak_fd = os.open(peak_file, os.O_RDWR | os.O_CLOEXEC)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EPERM) and os.geteuid() != 0:
            raise PrivilegeRequired(f"{peak_file} richiede accesso privilegiato per il reset: {error}") from error
        raise MeasurementError(f"{peak_file} non apribile in lettura/scrittura: {error}") from error

    try:
        try:
            if os.write(peak_fd, b"1") != 1:
                raise MeasurementError(f"reset di {peak_file} scritto parzialmente")
            os.lseek(peak_fd, 0, os.SEEK_SET)
        except (OSError, MeasurementError) as error:
            raise MeasurementError(f"reset di {peak_file} non riuscito: {error}") from error

        try:
            preexec_fn = None
            if drop_to is not None:
                uid, gid, username = drop_to

                def restore_caller_identity() -> None:
                    os.initgroups(username, gid)
                    os.setgid(gid)
                    os.setuid(uid)

                preexec_fn = restore_caller_identity
            result = subprocess.run(command, check=False, preexec_fn=preexec_fn)
        except OSError as error:
            raise MeasurementError(f"comando non avviabile: {error}") from error

        try:
            os.lseek(peak_fd, 0, os.SEEK_SET)
            raw_peak = os.read(peak_fd, 128).decode("ascii").strip()
        except (OSError, UnicodeDecodeError) as error:
            raise MeasurementError(f"peak cgroup non leggibile al termine del comando: {error}") from error
        if not re.fullmatch(r"[1-9][0-9]*", raw_peak):
            raise MeasurementError(f"peak cgroup non valido al termine del comando: {raw_peak!r}")

        peak_bytes = int(raw_peak)
        peak_mb = (peak_bytes + MIB - 1) // MIB
        peak_delta_bytes = max(0, peak_bytes - baseline_bytes)
        peak_delta_mb = (peak_delta_bytes + MIB - 1) // MIB
        limit_mb = limit_bytes // MIB
        print(
            "[typecheck-heap-cgroup] "
            f"baseline_cgroup_memory_bytes={baseline_bytes} "
            f"peak_cgroup_memory_bytes={peak_bytes} "
            f"peak_cgroup_memory_mb={peak_mb} "
            f"peak_delta_bytes={peak_delta_bytes} "
            f"peak_delta_mb={peak_delta_mb} "
            f"runner_limit_bytes={limit_bytes} "
            f"runner_limit_mb={limit_mb}",
            flush=True,
        )
        return result.returncode
    finally:
        os.close(peak_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--test-cgroup-dir",
        type=Path,
        help="current job cgroup fixture for regression tests; production uses the current cgroup",
    )
    parser.add_argument(
        "--test-cgroup-mount",
        type=Path,
        help="fixture mount root for testing ancestor memory.max limits",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        print("::error::uso: run-with-cgroup-memory-peak.py [--test-cgroup-dir DIR] -- comando...", file=sys.stderr)
        return 2

    try:
        if args.test_cgroup_dir is not None:
            group = args.test_cgroup_dir.resolve(strict=True)
            mount_point = (
                args.test_cgroup_mount.resolve(strict=True).as_posix()
                if args.test_cgroup_mount is not None
                else group.as_posix()
            )
            if os.path.commonpath((mount_point, group.as_posix())) != mount_point:
                raise MeasurementError("il cgroup fixture non è discendente della root fixture")
            for filename in ("memory.current", "memory.max", "memory.peak"):
                if not (group / filename).is_file():
                    raise MeasurementError(f"{group}/{filename} non disponibile nel test")
        else:
            group, mount_point = _cgroup_v2_mount()
        limit_bytes = _effective_runner_limit_bytes(group, mount_point)
        drop_to = None
        if os.geteuid() == 0 and os.environ.get("SUDO_UID"):
            try:
                uid = int(os.environ["SUDO_UID"])
                gid = int(os.environ["SUDO_GID"])
                username = pwd.getpwuid(uid).pw_name
            except (KeyError, ValueError, OSError) as error:
                raise MeasurementError(f"identità utente originale di sudo non valida: {error}") from error
            drop_to = (uid, gid, username)
        try:
            return _measure_command(group, limit_bytes, command, drop_to)
        except PrivilegeRequired:
            if args.test_cgroup_dir is not None:
                raise
            sudo = shutil.which("sudo", path="/usr/bin:/bin")
            if sudo is None:
                raise MeasurementError("reset di memory.peak negato e sudo non disponibile")
            preserved = [
                f"{name}={os.environ[name]}"
                for name in (
                    "HOME",
                    "PATH",
                    "NODE_OPTIONS",
                    "TMPDIR",
                    "CI",
                    "GITHUB_ACTIONS",
                    "GITHUB_WORKSPACE",
                    "RUNNER_TEMP",
                )
                if name in os.environ
            ]
            elevated = subprocess.run(
                [sudo, "-n", "/usr/bin/env", *preserved, sys.executable, *sys.argv],
                check=False,
            )
            return elevated.returncode
    except (MeasurementError, OSError) as error:
        print(f"::error::misura esatta del peak cgroup non verificabile: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
