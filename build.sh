#!/bin/bash
set -x
PREV_VERSION=$(dpkg-parsechangelog -c2 | grep -A 100 "^Changes:" | grep -o "(.*)" | tail -n1 | sed 's@(\|)@@g')
wget "https://launchpad.net/~yma-het/+archive/ubuntu/ton/+sourcefiles/ton-status/$PREV_VERSION/ton-status_0.1.orig.tar.xz" -O ../ton-status_0.1.orig.tar.xz
rm -rf debian/patches/
# suites for interactive session
# dpkg-source --commit
echo "patch-name" | dpkg-source --auto-commit --commit
TEMPDIR=$(mktemp -d)
mv debian $TEMPDIR/debian
dh_make --indep --createorig
rm -rf debian
mv $TEMPDIR/debian ./
# for interactive session we can build and sign in one pass
# debuild -sa -S
debuild -sa -S -us -uc