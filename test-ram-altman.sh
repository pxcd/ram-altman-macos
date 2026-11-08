#!/usr/bin/env bash
# Exercises ram-altman.sh with simulated memory and a fake sendmail.
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/ram-altman.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/state"

cat > "$work/bin/sendmail" <<EOF
#!/usr/bin/env bash
[[ -e "$work/fail" ]] && exit 75
cat >> "$work/outbox"
echo "=====END=====" >> "$work/outbox"
EOF
chmod +x "$work/bin/sendmail"

export PATH="$work/bin:$PATH"
export RAM_ALTMAN_TO=to@example.com RAM_ALTMAN_FROM=from@example.com
export RAM_ALTMAN_STATE_DIR="$work/state" RAM_ALTMAN_MEMINFO="$work/meminfo"

pass=0; fail=0
check() {
    if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "ok    $1"
    else fail=$((fail+1)); echo "FAIL  $1 (expected '$3', got '$2')"; fi
}
sent() { grep -c '^=====END=====$' "$work/outbox" 2>/dev/null || true; }
mem() { # total free available buffers cached slab shmem
    cat > "$work/meminfo" <<EOF
MemTotal:       $1 kB
MemFree:        $2 kB
${3:+MemAvailable:   $3 kB}
Buffers:        $4 kB
Cached:         $5 kB
SwapCached:     999999 kB
SReclaimable:   $6 kB
Shmem:          $7 kB
EOF
}

# Mostly page cache: little is free, but plenty is available.
mem 16000000 300000 9000000 200000 8000000 500000 100000
"$script"; check "cache counts as available: email sent" "$(sent)" 1
"$script"; "$script"; check "second and third run same day: no more email" "$(sent)" 1
check "used = total - available" "$(tail -n 1 "$work/state/usage.csv" | cut -d, -f3)" 7000000
check "three samples logged" "$(($(wc -l < "$work/state/usage.csv") - 1))" 3

# Next day, tight on memory.
echo 2000-01-01 > "$work/state/last_sent"
mem 16000000 300000 1000000 100000 800000 100000 100000
"$script"; check "6.2% available: no email" "$(sent)" 1

# Exactly 10% is not over 10%.
mem 16000000 300000 1600000 100000 800000 100000 100000
"$script"; check "exactly 10%: no email" "$(sent)" 1
mem 16000000 300000 1600001 100000 800000 100000 100000
"$script"; check "just over 10%: email sent" "$(sent)" 2

# A failed send is retried, and only recorded once it works.
echo 2000-01-01 > "$work/state/last_sent"
touch "$work/fail"
"$script" 2>/dev/null; check "failed send exits non-zero" "$?" 1
check "failed send releases lock" "$([[ -d "$work/state/run.lock" ]] && echo yes || echo no)" no
check "failed send not recorded" "$(cat "$work/state/last_sent")" 2000-01-01
rm "$work/fail"
"$script"; check "retry succeeds" "$(sent)" 3

# Old kernel with no MemAvailable: free + buffers + cached + slab - shmem.
# SwapCached in the fixture must not be picked up as Cached.
mem 16000000 1000000 "" 200000 3000000 500000 700000
out=$("$script" --status)
check "fallback estimate" "$(awk '/^Available:/ {print $2, $3}' <<<"$out")" "3.8 GiB"

# Variety: 10 bodies should all appear across 10 days, with no back-to-back repeat.
rm -f "$work/outbox" "$work/state"/bag_*
mem 16000000 300000 9000000 200000 8000000 500000 100000
for _ in $(seq 40); do echo 2000-01-01 > "$work/state/last_sent"; "$script"; done
awk 'BEGIN{RS="=====END=====\n"} NF{n=split($0,l,"\n"); for(i=1;i<=n;i++) if(l[i]=="Hi Sam,"){b=l[i+2]; print b}}' \
    "$work/outbox" > "$work/bodies"
check "all opening lines used" "$(head -n 10 "$work/bodies" | sort -u | wc -l | tr -d ' ')" 10
check "no back-to-back repeat" "$(uniq -d "$work/bodies" | wc -l | tr -d ' ')" 0

# Config errors.
RAM_ALTMAN_TO='' "$script" 2>/dev/null; check "missing recipient refused" "$?" 1

# Force the Darwin path with stock command fixtures, even on Linux.
cat > "$work/bin/uname" <<'EOF'
#!/bin/bash
echo Darwin
EOF
cat > "$work/bin/sysctl" <<'EOF'
#!/bin/bash
[[ "${FAIL_SYSCTL:-}" ]] && exit 1
echo 17179869184
EOF
cat > "$work/bin/vm_stat" <<'EOF'
#!/bin/bash
[[ "${FAIL_VM_STAT:-}" ]] && exit 1
cat "$RAM_ALTMAN_VM_FIXTURE"
EOF
chmod +x "$work/bin/uname" "$work/bin/sysctl" "$work/bin/vm_stat"
export RAM_ALTMAN_VM_FIXTURE="$work/vm_stat"
mac_mem() {
    cat > "$work/vm_stat" <<EOF
Mach Virtual Memory Statistics: (page size of $1 bytes)
Pages free: 65536.
Pages active: 262144.
Pages inactive: 131072.
Pages speculative: 65536.
Pages purgeable: 65536.
Pages occupied by compressor: 65536.
EOF
}
mac_status() { RAM_ALTMAN_MEMINFO='' "$script" --status; }
mac_mem 16384
out=$(mac_status)
check "Darwin total from hw.memsize" "$(awk '/^Total:/ {print $2, $3}' <<<"$out")" "16.0 GiB"
check "16 KiB pages, no purgeable double counting" "$(awk '/^Available:/ {print $2, $3}' <<<"$out")" "4.0 GiB"
check "Darwin used excludes estimated available" "$(awk '/^Used:/ {print $2, $3}' <<<"$out")" "12.0 GiB"
out=$(RAM_ALTMAN_MEMINFO='' "$script" --dry-run)
check "Darwin email labels estimate" "$(grep -q 'estimated' <<<"$out" && echo yes || echo no)" yes
mac_mem 4096
out=$(mac_status)
check "4 KiB pages" "$(awk '/^Available:/ {print $2, $3}' <<<"$out")" "1.0 GiB"
FAIL_SYSCTL=1 mac_status >/dev/null 2>&1; check "sysctl failure refused" "$?" 1
FAIL_VM_STAT=1 mac_status >/dev/null 2>&1; check "vm_stat failure refused" "$?" 1
echo malformed > "$work/vm_stat"
mac_status >/dev/null 2>&1; check "malformed vm_stat refused" "$?" 1
mac_mem 1048576
out=$(mac_status)
check "available clamped to total" "$(awk '/^Available:/ {print $2, $3}' <<<"$out")" "16.0 GiB"

for threshold in -1 101 nope '1+2'; do
    RAM_ALTMAN_THRESHOLD="$threshold" "$script" --status >/dev/null 2>&1
    check "invalid threshold $threshold refused" "$?" 1
done
# An overlapping process cannot sample or send, even without flock.
mac_mem 16384
before=$(wc -l < "$work/state/usage.csv")
mkdir "$work/state/run.lock"
RAM_ALTMAN_MEMINFO='' "$script"
check "held lock skips sample" "$(wc -l < "$work/state/usage.csv")" "$before"
rmdir "$work/state/run.lock"
mac_state="$work/mac state"
RAM_ALTMAN_MEMINFO='' RAM_ALTMAN_STATE_DIR="$mac_state" "$script" --dry-run >/dev/null
check "dry run creates no state" "$([[ -e "$mac_state" ]] && echo yes || echo no)" no
RAM_ALTMAN_MEMINFO='' RAM_ALTMAN_STATE_DIR="$mac_state" "$script"
check "Darwin sample logged in path with spaces" "$(tail -n 1 "$mac_state/usage.csv" | cut -d, -f4)" 4194304
check "lock released on exit" "$([[ -d "$mac_state/run.lock" ]] && echo yes || echo no)" no
rm "$work/bin/uname" "$work/bin/sysctl" "$work/bin/vm_stat"

echo; echo "--- sample dry run ---"
mem 16000000 300000 9000000 200000 8000000 500000 100000
"$script" --dry-run
echo; echo "$pass passed, $fail failed"
exit "$fail"
