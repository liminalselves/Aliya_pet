# 第三方组件与许可 / Third-Party Notices

本仓库不附带开源许可：程序代码与项目贡献归 liminalselves 组织所有，美术资产的权利归其作者所有，具体使用条件见 `README.md` 的「许可 / License」一节。下列目录中的文件由第三方提供，各自适用其原许可，本仓库不对其重新授权。

This repository ships no open-source license: the code and project contributions are attributed to the liminalselves organization, while rights in the art assets remain with their author, and their terms of use are described in the License section of `README.md`. The directories listed below contain third-party files, each governed by its own license; this repository does not re-license them.

## 组件清单 / Components

| 组件 / Component | 位置 / Location | 许可 / License |
| --- | --- | --- |
| Live2D Cubism Web Framework | `third_party/cubism-web-sdk/Framework/` | [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)（见 `third_party/cubism-web-sdk/Framework/LICENSE.md`） |
| Live2D Cubism Core for Web（SDK 原件与前端副本） | `third_party/cubism-web-sdk/Core/`、`redesign/ui/assets/core/live2dcubismcore.js` | [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)（见 `third_party/cubism-web-sdk/Core/LICENSE.md`）；可再分发文件清单见 `third_party/cubism-web-sdk/Core/RedistributableFiles.txt` |
| Cubism WebGL 着色器（与 SDK Framework 内同名文件内容一致） | `redesign/ui/assets/shaders/` | Live2D Open Software License |
| Noto Serif SC | `redesign/ui/assets/fonts/` | SIL Open Font License 1.1（见同目录 `OFL.txt`） |

## Live2D 许可要点 / Live2D licensing notes

- **Framework 与 Cubism WebGL 着色器**适用 [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)。
- **Cubism Core**（含前端副本）适用 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)，不适用上述开放软件许可。
- 最近一个会计年度销售额达到或超过 **1000 万日元** 的事业主体，须另行取得 **Cubism SDK Release License**：<https://www.live2d.com/en/download/cubism-sdk/release-license/>
- 再分发 Cubism Core 时只能使用 Live2D 指定的可再分发文件，清单见 `third_party/cubism-web-sdk/Core/RedistributableFiles.txt`。
- 完整条款以 `third_party/cubism-web-sdk/LICENSE.md` 与 `Core/LICENSE.md`、`Framework/LICENSE.md` 为准；此处仅为指引，不构成对原许可的修改。

## 美术资产 / Art assets

`redesign/ui/assets/` 下除上表列出的第三方文件外，其余内容（Live2D 模型文件、贴图、动作与表情数据、背景、图标、对话文本）均由本程序作者制作，保留所有权利；具体使用条件见 `README.md` 的「许可 / License」一节。
