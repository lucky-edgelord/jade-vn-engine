#!/bin/sh
# Live2D for the test scene: the Cubism Core runtime and Live2D's "Hiyori" sample model.
# Both belong to Live2D Inc. By running this you accept the Live2D Proprietary Software License (Core)
# and the Free Material License (Hiyori): https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
# They are downloaded into assets/ and are git-ignored; they are not part of this repository.
set -e
cd "$(dirname "$0")/../assets"
curl -fsSL -o live2dcubismcore.min.js https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
B=https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/Hiyori
mkdir -p hiyori/Hiyori.2048 hiyori/motions
for f in Hiyori.model3.json Hiyori.moc3 Hiyori.physics3.json Hiyori.pose3.json Hiyori.cdi3.json Hiyori.userdata3.json \
         Hiyori.2048/texture_00.png Hiyori.2048/texture_01.png; do curl -fsSL -o "hiyori/$f" "$B/$f"; done
for n in 01 02 03 04 05 06 07 08 09 10; do curl -fsSL -o "hiyori/motions/Hiyori_m$n.motion3.json" "$B/motions/Hiyori_m$n.motion3.json"; done
echo "Live2D files are in $(pwd)"
