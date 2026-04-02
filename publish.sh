#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-latest}"
IMAGE="knight1988/9router:${TAG}"

echo "Building ${IMAGE}..."
docker build -t "${IMAGE}" .

echo "Pushing ${IMAGE}..."
docker push "${IMAGE}"

echo "Done: ${IMAGE}"
