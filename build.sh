#!/bin/bash
wget "https://launchpad.net/~yma-het/+archive/ubuntu/ton/+sourcefiles/ton-status/0.1-20/ton-status_0.1.orig.tar.xz" -O ../ton-status_0.1.orig.tar.xz
rm -rf debian/patches/
dpkg-source --commit
TEMPDIR=$(mktemp -d)
mv debian $TEMPDIR/debian
dh_make --indep --createorig
rm -rf debian
mv $TEMPDIR/debian ./
debuild -sa -S
