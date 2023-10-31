#!/bin/bash
set -e
wget https://deb.nodesource.com/node_20.x/pool/main/n/nodejs/nodejs_20.9.0-1nodesource1_amd64.deb
ar x nodejs_20.9.0-1nodesource1_amd64.deb
unxz data.tar.xz
tar -xvf data.tar
rm control.tar.gz data.tar debian-binary nodejs_20.9.0-1nodesource1_amd64.deb
export PATH=$(pwd)/usr/bin/:$PATH
$(pwd)/usr/bin/npm install yarn
YARN="$(pwd)/usr/bin/node $(pwd)/node_modules/.bin/yarn"
$YARN install
$YARN tsc --p tsconfig.json
$YARN add pkg
$YARN pkg --targets node18-linux-x64 --config package.json getStatus.js
mv ton-status debian/ton-status_
rm getStatus.js package-lock.json
rm -rf node_modules/
rm -rf usr/
