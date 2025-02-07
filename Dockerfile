# Use a Rust base image with Cargo installed
FROM ubuntu:focal AS builder

# install build deps
RUN apt update && DEBIAN_FRONTEND=noninteractive apt -y install build-essential binutils wget xz-utils dh-exec devscripts dh-make

# Set the working directory inside the container
WORKDIR /usr/src/app

COPY getStatus.ts package.json tsconfig.json local_build.sh build.sh ./
COPY debian/ ./debian/

# Build the dependencies without the actual source code to cache dependencies separately

RUN ./local_build.sh

RUN ./build.sh || true

RUN ls ..

# RUN USER=root dh_make --createorig -p ton-status_0.1 -C=indep

# RUN dpkg-buildpackage

# # Now copy the source code
# COPY ./src ./src
# COPY ./protos ./protos
# COPY ./build.rs ./build.rs

# # Build your application
# RUN cargo build --release

# # Start a new stage to create a smaller image without unnecessary build dependencies
# FROM debian:bullseye-slim

# # Set the working directory
# WORKDIR /usr/src/app

# # Copy the built binary from the previous stage
# COPY --from=builder /usr/src/app/target/release/emulator_farm ./

# # install deps
# RUN apt update && apt -y install liblz4-1 libsecp256k1-0 libsodium23

# # Command to run the application
# CMD ["./emulator_farm"]