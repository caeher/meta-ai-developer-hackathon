#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "sandbox_quota_provision_requires_root"
[[ "${SANDBOX_DOCKER_SOCKET:-}" == /* ]] || fail "sandbox_docker_socket_path_required"
[[ "${SANDBOX_IMAGE:-}" == *@sha256:* ]] || fail "sandbox_image_must_be_digest_pinned"
[[ "${SANDBOX_DISK_MB:-}" =~ ^[0-9]+$ ]] || fail "sandbox_disk_limit_invalid"
disk_mb=$((10#${SANDBOX_DISK_MB}))
(( disk_mb >= 64 && disk_mb <= 65536 )) || fail "sandbox_disk_limit_invalid"

for command in docker findmnt jq repquota setquota; do
  command -v "$command" >/dev/null 2>&1 || fail "sandbox_quota_command_missing_${command}"
done

docker=(docker --host "unix://${SANDBOX_DOCKER_SOCKET}")
docker_info="$("${docker[@]}" info --format '{{json .}}')" || fail "rootless_docker_unavailable"
jq -e 'any(.SecurityOptions[]?; ascii_downcase | contains("rootless"))' <<< "$docker_info" >/dev/null \
  || fail "rootless_docker_required"
docker_root="$(jq -er '.DockerRootDir | select(startswith("/"))' <<< "$docker_info")" \
  || fail "rootless_docker_data_root_invalid"
[[ "$docker_root" == /* && -d "$docker_root" ]] || fail "rootless_docker_data_root_invalid"

read -r mountpoint filesystem mount_options < <(
  findmnt --noheadings --output TARGET,FSTYPE,OPTIONS --target "$docker_root"
) || fail "sandbox_quota_filesystem_unavailable"
[[ "$filesystem" == "ext4" || "$filesystem" == "xfs" ]] || fail "sandbox_quota_requires_ext4_or_xfs"
case ",$mount_options," in
  *,usrquota,*|*,uquota,*) ;;
  *) fail "sandbox_user_quotas_not_enabled_on_docker_filesystem" ;;
esac
repquota -u "$mountpoint" >/dev/null 2>&1 || fail "sandbox_user_quotas_not_active"

uid_map_program="const fs=require('node:fs');process.stdout.write(JSON.stringify(fs.readFileSync('/proc/self/uid_map','utf8').trim().split('\\n').map(line=>line.trim().split(/\\s+/).map(Number))))"
uid_map="$("${docker[@]}" run --rm --network none --read-only --memory 64m --memory-swap 64m --pids-limit 16 \
  --cap-drop ALL --security-opt no-new-privileges:true --user 60000:60000 --entrypoint node "$SANDBOX_IMAGE" -e "$uid_map_program")" \
  || fail "sandbox_uid_map_probe_failed"
disk_quota_kib=$((disk_mb * 1024))
quota_rows="$(mktemp)"
trap 'rm -f -- "$quota_rows"' EXIT

printf '%s\n' "$uid_map" | jq -er --argjson limit "$disk_quota_kib" '
  . as $map
  | [range(10000; 60000) as $uid
      | ($map[] | select($uid >= .[0] and $uid < (.[0] + .[2])) | (.[1] + $uid - .[0]))]
  | if length != 50000 then error("uid range is not fully mapped")
    elif (unique | length) != 50000 then error("mapped host uid range is not unique")
    else .[] | "\(.) \($limit) \($limit) 0 0"
    end
' > "$quota_rows" || fail "sandbox_uid_range_not_unique_and_mapped"
[[ "$(wc -l < "$quota_rows")" -eq 50000 ]] || fail "sandbox_uid_quota_rows_incomplete"

probe_host_uid="$(printf '%s\n' "$uid_map" | jq -er '
  . as $map
  | [ $map[] | select(60000 >= .[0] and 60000 < (.[0] + .[2])) | (.[1] + 60000 - .[0]) ]
  | if length != 1 or .[0] == 0 then error("quota probe uid is not mapped") else .[0] end
')" || fail "sandbox_quota_probe_uid_unmapped"
if [[ "$(awk -v id="$probe_host_uid" '$1 == id { found=1 } END { print found ? "yes" : "no" }' "$quota_rows")" == "yes" ]]; then
  fail "sandbox_quota_probe_uid_overlaps_runtime_range"
fi

{
  cat "$quota_rows"
  printf '%s %s %s 0 0\n' "$probe_host_uid" "$((16 * 1024))" "$((16 * 1024))"
} | setquota --batch --user "$mountpoint" || fail "sandbox_user_quota_install_failed"

printf 'sandbox_user_quotas_provisioned fs=%s uid_range=10000-59999 disk_mb=%s probe_uid=60000 probe_mb=16\n' \
  "$filesystem" "$disk_mb"
