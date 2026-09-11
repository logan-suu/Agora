ARG BASE_IMAGE=node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${BASE_IMAGE}
WORKDIR /opt/benchmark
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
ENV NODE_PATH=/opt/benchmark/node_modules
WORKDIR /workspace
