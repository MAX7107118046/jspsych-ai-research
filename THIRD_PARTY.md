# Dependencies and notices

| Dependency | Version | License | Use |
| --- | --- | --- | --- |
| jspsych | 7.3.4 | MIT | Peer runtime |
| ajv | 8.17.1 | MIT | JSON Schema validation, bundled |
| fast-deep-equal | resolved by package-lock | MIT | AJV dependency, bundled |
| fast-uri | resolved by package-lock | BSD-3-Clause | AJV dependency, bundled |
| json-schema-traverse | resolved by package-lock | MIT | AJV dependency, bundled |
| require-from-string | resolved by package-lock | MIT | AJV dependency |
| esbuild | 0.28.2 | MIT | Build tooling |
| typescript | 7.0.2 | Apache-2.0 | Type checking and declarations |
| playwright | 1.59.1 | Apache-2.0 | Browser acceptance |
| ws | 8.18.3 | MIT | Server speech WebSocket proxy |
| @jspsych official plugins | versions in package.json | MIT | Examples and acceptance |

构建产物中的第三方许可保存在 `dist/licenses/`。`package-lock.json` 固定完整依赖树。旧插件用于功能盘点和迁移设计；新实现未复制其虚构联系方式或仓库地址。
