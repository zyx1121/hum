#!/bin/sh
# Install or update disk-watch on a PVE node: scp disk-watch <node>:/tmp/disk-watch, then ssh <node> sh < install.sh
set -e
install -m 755 /tmp/disk-watch /usr/local/sbin/disk-watch; rm /tmp/disk-watch
if [ ! -f /etc/systemd/system/disk-watch.timer ]; then
printf "[Unit]\nDescription=Report this node's storage health to sensorium\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/disk-watch\n" > /etc/systemd/system/disk-watch.service
printf "[Unit]\nDescription=Run disk-watch every 10 minutes\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=10min\nAccuracySec=30s\n\n[Install]\nWantedBy=timers.target\n" > /etc/systemd/system/disk-watch.timer
systemctl daemon-reload; systemctl enable --now disk-watch.timer >/dev/null 2>&1
fi
/usr/local/sbin/disk-watch
