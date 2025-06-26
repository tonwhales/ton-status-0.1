FROM node:22-alpine as build
WORKDIR /build
COPY getStatus.ts package.json tsconfig.json ./
RUN yarn install
RUN yarn tsc
RUN yarn cache clean


FROM node:22-alpine
WORKDIR /src
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules/ ./node_modules
COPY --from=build /build/getStatus.js ./

CMD yarn start