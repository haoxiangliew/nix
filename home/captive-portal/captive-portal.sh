# shellcheck shell=bash

# A captive portal has to hijack DNS to send you to its sign-in page, and it
# cannot hijack DNS-over-TLS. The TLS handshake fails instead, so nothing
# resolves and the sign-in page never appears. Turn DNS-over-TLS off on one
# link, sign in, then turn it back on.

if [ -t 1 ]; then
  bold=$'\e[1m'
  dim=$'\e[2m'
  reset=$'\e[0m'
else
  bold=""
  dim=""
  reset=""
fi

for cmd in nmcli resolvectl; do
  if ! command -v "$cmd" >/dev/null; then
    echo "$cmd not found, this needs NetworkManager and systemd-resolved on the host" >&2
    exit 1
  fi
done

# Portals are nearly always on wifi, so try the connected wifi link first.
# Fall back to any connected link for tethering and hotel ethernet.
link="${1:-}"
if [ -z "$link" ]; then
  link=$(nmcli -t -f DEVICE,TYPE,STATE device status |
    awk -F: '$2 == "wifi" && $3 ~ /^connected/ { print $1; exit }')
fi
if [ -z "$link" ]; then
  link=$(nmcli -t -f DEVICE,TYPE,STATE device status |
    awk -F: '$3 ~ /^connected/ { print $1; exit }')
fi
if [ -z "$link" ]; then
  echo "no connected link, join the network first and run this again" >&2
  exit 1
fi

protocols() {
  # systemd 247 and newer report DNS-over-TLS in the per-link Protocols line.
  # Older releases print a separate "DNSOverTLS setting:" line. Match either.
  resolvectl status "$link" | awk '/DNSOverTLS/ { $1 = $1; print; exit }'
}

confirm() {
  local reply
  read -r -p "$1 [y/N] " reply || true
  case "$reply" in
  [yY] | [yY][eE][sS]) return 0 ;;
  *) return 1 ;;
  esac
}

# An exit with DNS-over-TLS still off would leave DNS in plaintext, so the
# revert runs on every exit path, interrupts included.
dot_off=0
restore() {
  [ "$dot_off" -eq 1 ] || return 0
  dot_off=0
  echo
  echo "${bold}4/4${reset} restoring DNS-over-TLS on $link"
  resolvectl revert "$link" || echo "     revert failed, run: resolvectl revert $link" >&2
  resolvectl flush-caches || echo "     flush failed, run: resolvectl flush-caches" >&2
  echo "     ${dim}$(protocols)${reset}"
}
trap restore EXIT
trap 'restore; exit 130' INT TERM

echo
echo "${bold}captive portal sign-in${reset} on $link"
echo "${dim}$(protocols)${reset}"
echo
echo "resolvectl goes through polkit, so this may ask for your password."
echo "DNS-over-TLS goes back on before this exits, interrupts included."
echo

confirm "${bold}1/4${reset} turn DNS-over-TLS off on $link?" || {
  echo "     nothing changed."
  exit 0
}
if ! resolvectl dnsovertls "$link" no; then
  echo "     could not turn it off, try: sudo resolvectl dnsovertls $link no" >&2
  exit 1
fi
dot_off=1
resolvectl flush-caches || true
echo "     ${dim}$(protocols)${reset}"

echo
echo "${bold}2/4${reset} asking NetworkManager to re-check connectivity"
state=$(nmcli networking connectivity check || echo unknown)
echo "     connectivity: $state"
case "$state" in
portal) echo '     look for the GNOME "Sign in to network" prompt.' ;;
full) echo "     already online, nothing in the way." ;;
*) echo "     no portal reported, try the sign-in page anyway." ;;
esac

echo
echo "${bold}3/4${reset} sign in to the portal"
if confirm "     no sign-in window? open a plain HTTP page"; then
  # Plain HTTP and no HSTS, so the portal can redirect it. An HTTPS URL would
  # fail certificate validation instead of showing the sign-in page.
  xdg-open http://neverssl.com >/dev/null 2>&1 ||
    echo "     open http://neverssl.com by hand" >&2
fi
read -r -p "     press enter once you are through the portal " || true

restore

echo
echo "connectivity: $(nmcli networking connectivity check || echo unknown)"
