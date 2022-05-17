#!/bin/bash
TEMPDIR=$(mktemp -d)
mv debian $TEMPDIR/debian
dh_make --indep --createorig
rm -rf debian
mv $TEMPDIR/debian ./
debuild -sa -S
