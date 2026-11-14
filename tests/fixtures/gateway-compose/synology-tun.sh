# GateControl-Gateway (Synology): /dev/net/tun bereitstellen, dann Gateway starten
PATH="$PATH:/usr/local/bin:/usr/sbin:/sbin:/usr/bin:/bin"
modprobe tun 2>/dev/null || insmod "$(find /lib/modules -name 'tun.ko*' | head -n 1)" 2>/dev/null
mkdir -p /dev/net
[ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200
chmod 0666 /dev/net/tun
n=0
until docker info >/dev/null 2>&1; do
  n=$((n + 1)); [ "$n" -lt 24 ] || exit 1
  sleep 5
done
for c in $(docker ps -aq --filter status=exited --filter status=created); do
  case "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.Config.Image}}' "$c")" in
    "gateway "*gatecontrol-gateway* | "otbr "*openthread/otbr*) docker start "$c" ;;
  esac
done
