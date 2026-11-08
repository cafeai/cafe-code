#!/bin/sh
# Root-owned remote-only maintenance. Certbot's ordinary account/private keys
# stay on this VPS. Temporary port 80 is always closed after the ACME operation.
set -eu
exec 9>/run/cafecode-relay-acme.lock
flock -n 9 || exit 0
acme_lineage=/etc/letsencrypt/live/cafecode-relay-test
acme_root=/etc/cafecode-relay-test
acme_viewer=/etc/cafecode-relay-viewer
publish_certificate() {
  openssl x509 -in "$acme_lineage/fullchain.pem" -noout -checkend 604800 >/dev/null
  acme_key_digest=$(openssl pkey -in "$acme_lineage/privkey.pem" -pubout -outform DER | sha256sum)
  acme_cert_digest=$(openssl x509 -in "$acme_lineage/fullchain.pem" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
  test "$acme_key_digest" = "$acme_cert_digest"
  install -o root -g cafecode-relay-test -m 0640 "$acme_lineage/privkey.pem" "$acme_root/tls.key.next"
  install -o root -g cafecode-relay-test -m 0640 "$acme_lineage/fullchain.pem" "$acme_root/tls.crt.next"
  mv -f "$acme_root/tls.key.next" "$acme_root/tls.key"
  mv -f "$acme_root/tls.crt.next" "$acme_root/tls.crt"
  if test -d "$acme_viewer"; then
    install -o root -g cafecode-relay-viewer -m 0640 "$acme_lineage/privkey.pem" "$acme_viewer/tls.key.next"
    install -o root -g cafecode-relay-viewer -m 0640 "$acme_lineage/fullchain.pem" "$acme_viewer/tls.crt.next"
    mv -f "$acme_viewer/tls.key.next" "$acme_viewer/tls.key"
    mv -f "$acme_viewer/tls.crt.next" "$acme_viewer/tls.crt"
  fi
  if systemctl is-active --quiet cafecode-relay-test.service; then systemctl reload cafecode-relay-test.service; fi
  if systemctl is-active --quiet cafecode-relay-viewer.service; then systemctl reload cafecode-relay-viewer.service; fi
}
if test "${1:-}" = --close-abandoned; then ufw --force delete allow 80/tcp >/dev/null 2>&1 || true; exit 0; fi
if test "${1:-}" = --publish-only; then publish_certificate; exit 0; fi
cleanup_acme() { ufw --force delete allow 80/tcp >/dev/null 2>&1 || true; }
trap cleanup_acme EXIT
trap 'exit 1' HUP INT TERM
ufw allow 80/tcp comment cafecode-relay-acme >/dev/null
certbot renew --non-interactive --cert-name cafecode-relay-test --no-random-sleep-on-renew --quiet
cleanup_acme
trap - EXIT HUP INT TERM
publish_certificate
