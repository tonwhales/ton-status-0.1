#!/bin/bash
wget https://deb.nodesource.com/node_16.x/pool/main/n/nodejs/nodejs_16.14.2-deb-1nodesource1_amd64.deb
ar x nodejs_16.14.2-deb-1nodesource1_amd64.deb
unxz data.tar.xz
tar -xvf data.tar
rm control.tar.gz data.tar debian-binary nodejs_16.14.2-deb-1nodesource1_amd64.deb
export PATH=$PATH:$(pwd)/usr/bin/
npm install
npm install typescript
./node_modules/typescript/bin/tsc --esModuleInterop --target ES2019 --moduleResolution node --module commonjs getStatus.ts
npm install pkg
./node_modules/.bin/pkg --targets node16-linux-x64 --config package.json getStatus.js
mv ton-status debian/ton-status_
rm getStatus.js package-lock.json
rm -rf node_modules/
rm -rf usr/
