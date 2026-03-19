#!/usr/bin/env bash
set -euo pipefail

IMAGE="knight1988/9router:latest"

echo "Building ${IMAGE}..."
docker build -t "${IMAGE}" .

echo "Pushing ${IMAGE}..."
docker push "${IMAGE}"

echo "Done: ${IMAGE}"
