#!/bin/sh
# Offline play: download Live2D's Cubism Core runtime into assets/ (it is git-ignored, not part of this repository).
# By running this you accept the Live2D Proprietary Software License:
# https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
# Then remove the `define config.live2d_core = ...` line in script.rpy so the game uses the local copy.
# Jade's model itself (assets/jade-live2d/) is Jade Vault's own asset and is in the repository.
set -e
cd "$(dirname "$0")/../assets"
curl -fsSL -o live2dcubismcore.min.js https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
echo "Cubism Core is in $(pwd)"
