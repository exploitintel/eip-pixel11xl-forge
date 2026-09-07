#!/system/bin/sh
# Restore the Docker policy-routing rules Android's netd does not keep.
# Without these: containers on compose networks have no DNS or egress, and
# published ports refuse. netd rejects "ip rule add" from the shell, so the
# rules are added from a privileged container in the host namespace. The Wi-Fi
# table is referenced by its numeric id because its name is not resolvable
# inside a container.
export DOCKER_HOST=unix:///data/docker/run/docker.sock
D=/data/docker/bin/docker
WLAN_TABLE=$(ip rule show | sed -n 's/.*iif docker0 lookup \([0-9]*\).*/\1/p' | head -1)
[ -n "$WLAN_TABLE" ] || WLAN_TABLE=1016
$D run --rm --privileged --network host --platform linux/arm64 alpine sh -c "
  apk add --no-cache iproute2 >/dev/null 2>&1
  ip rule show | grep -q 'to 172.16.0.0/12'   || ip rule add pref 9991 to 172.16.0.0/12 lookup main
  ip rule show | grep -q 'from 172.16.0.0/12' || ip rule add pref 9992 from 172.16.0.0/12 lookup $WLAN_TABLE
  ip rule show | grep 172
" 2>&1 | tail -5
