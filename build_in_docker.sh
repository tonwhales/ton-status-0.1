#!/bin/bash
set -e -u -o pipefail
DOCKER_LOG="$(docker build --platform=linux/amd64 . | tee /dev/tty)"
IMAGE_ID=$(echo "$DOCKER_LOG" | tail -n1)
echo "Imgage id: $IMAGE_ID"
FILES="$(docker run --rm $IMAGE_ID ls .. | grep -v app)"
DEB_NAME=$(echo "$FILES" | grep ".dsc")
VERSION=$(basename $DEB_NAME .dsc)
# echo "Making dir for version: $VERSION"
# mkdir -p $VERSION
# for FILE in $(echo "$FILES"); do
#     echo "Copying $FILE"
#     docker run --rm $IMAGE_ID cat ../$FILE > $VERSION/$FILE
# done
# This command not only checks connection but also starts agent
gpg-connect-agent /bye
# fixme: add correct selinux rule
sudo setenforce 0
PKEY=$(gpg --armor --export yma.het@gmail.com)
docker run -it -v /run/user/$(id -u)/gnupg/S.gpg-agent:/root/.gnupg/S.gpg-agent:Z --rm $IMAGE_ID bash -c "echo \"$PKEY\" | gpg --import; echo 'use-agent' > /root/.gnupg/gpg.conf ; echo 'pinentry-mode loopback' >> /root/.gnupg/gpg.conf ; cd .. ; debsign "$VERSION"_source.changes; dput ppa:yma-het/ton "$VERSION"_source.changes"