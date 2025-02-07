#!/bin/bash
set -ex
URL="https://deb.nodesource.com/node_22.x/pool/main/n/nodejs/nodejs_22.13.1-1nodesource1_amd64.deb"
wget $URL
ar x $(basename $URL)
unxz data.tar.xz
tar -xvf data.tar
rm control.tar.xz data.tar debian-binary $(basename $URL)
export PATH=$(pwd)/usr/bin/:$PATH
$(pwd)/usr/bin/npm install yarn
YARN="$(pwd)/usr/bin/node $(pwd)/node_modules/.bin/yarn"
$YARN install
$YARN tsc --p tsconfig.json
$YARN add pkg
$YARN pkg --targets latest-linux-x64 --config package.json getStatus.js
mv ton-status debian/ton-status_
rm getStatus.js package-lock.json
rm -rf node_modules/
rm -rf usr/
