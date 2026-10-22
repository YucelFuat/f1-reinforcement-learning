# Third-party notices

This project's own code is released under the [MIT License](LICENSE). It also includes or is derived from the following third-party works.

| Component | Where | License |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) r160 (core and example add-ons: GLTFLoader, BufferGeometryUtils, post-processing passes and shaders, SimplexNoise) | `vendor/` | MIT. See `vendor/three-LICENSE.txt` and `vendor/addons/LICENSE`. |
| [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits): circuit centre-line geometry (İstanbul Park, Monza, Spa-Francorchamps, Silverstone), projected, resampled and smoothed | `src/tracks/real.js` | MIT, Copyright (c) 2019-2025 Tomislav Bacinger |
| [TracingInsights](https://github.com/TracingInsights) public F1 telemetry archive: elevation profiles, start/finish alignment and race direction (derived), plus one reference lap per circuit (distance, speed, throttle, brake, gear, rpm, time) | `src/tracks/real.js`, `src/tracks/reftel/*.json` | Apache License 2.0. The data originates from Formula 1 official timing. The reference laps were resampled to 5 m steps and converted to JSON; no other changes. A copy of the license is at https://www.apache.org/licenses/LICENSE-2.0 |

## Other notes

- The Austin (COTA) centre line was traced from a circuit map. Its elevation profile was digitised from a public elevation chart.
- The 3D car (`assets/f1car.glb`, `assets/f1car.blend`) was modelled for this project and is covered by the project's MIT license.
- All sponsor and brand names shown in the 3D scene are fictional.
- This project is not affiliated with, endorsed by or connected to Formula 1, the FIA, any team or any driver. "Formula 1", "F1" and related marks are trademarks of Formula One Licensing B.V. Driver names and lap times appear only as factual reference data.
