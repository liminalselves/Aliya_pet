const fs = require('fs');
const path = require('path');

const project = __dirname;
const sdk = path.resolve(project, '../../../third_party/CubismSdkForWeb-5-r.5');
const publicRoot = path.join(project, 'public');

fs.rmSync(publicRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(publicRoot, 'Core'), { recursive: true });
fs.mkdirSync(path.join(publicRoot, 'Framework', 'Shaders', 'WebGL'), { recursive: true });
fs.copyFileSync(
  path.join(sdk, 'Core', 'live2dcubismcore.js'),
  path.join(publicRoot, 'Core', 'live2dcubismcore.js')
);
fs.cpSync(
  path.join(sdk, 'Framework', 'Shaders', 'WebGL'),
  path.join(publicRoot, 'Framework', 'Shaders', 'WebGL'),
  { recursive: true }
);
