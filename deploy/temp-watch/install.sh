#!/bin/sh
# Install or update temp-watch on a PVE node: scp temp-watch <node>:/tmp/temp-watch, then ssh <node> sh < install.sh
set -e
install -m 755 /tmp/temp-watch /usr/local/sbin/temp-watch; rm /tmp/temp-watch
if [ ! -f /etc/systemd/system/temp-watch.timer ]; then
printf "[Unit]\nDescription=Report this node's temperatures to sensorium\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/temp-watch\n" > /etc/systemd/system/temp-watch.service
printf "[Unit]\nDescription=Run temp-watch every 60 seconds\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=60s\nAccuracySec=5s\n\n[Install]\nWantedBy=timers.target\n" > /etc/systemd/system/temp-watch.timer
systemctl daemon-reload; systemctl enable --now temp-watch.timer >/dev/null 2>&1
fi
/usr/local/sbin/temp-watch
