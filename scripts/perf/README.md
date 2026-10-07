# 可复现的性能实验

先使用 Node 24 编译 Schema，并准备完整的生产静态构建。列表全量对照只有 `--mode performance` 构建启用；普通生产页面不会因 URL 参数关闭虚拟化。

```sh
npm run build:schema
npm run build -w apps/web -- --mode performance
node --test scripts/tests/performance-fixtures.test.mjs
node scripts/perf/snapshot-seek-benchmark.mjs --out=artifacts/perf/snapshot-seek.json
CODE_TAPE_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/perf/browser-benchmark.mjs --after-web-root=apps/web/dist --out=artifacts/perf/browser.json --power-mode=AC
```

正式默认：每路由、环境、版本分别 10 个冷缓存和 10 个暖缓存样本，10 秒无交互 LCP 观察窗，100 个交替正反向 Seek（另有 10 个预热操作）。桌面与 CPU 4×、10 Mbps、100 ms 两组。单页、单 Chromium 顺序运行；运行期间避免并行构建、推理或其他浏览器实验。`--power-mode` 应填写真实状态，没有填写时明确记录 `unreported`。

如准备了 fork 主分支 `0ac9097` 的独立生产构建，增加 `--before-web-root=/path/to/baseline/apps/web/dist`。路由实验交替测 A/B；两端使用同一份 0.1.0 录制字节。旧版只有 Slider，不能用于“全量事件列表”对照；列表实验只在新版的同一列表上比较 `?benchmark=full` 与虚拟化。

本轮基线使用旧代码 source 与两组共用的升级后锁定依赖，旧版 Schema 显式保持 0.1.0。这用于控制依赖变量，不能称为“旧 lockfile 环境实机复现”。报告里的 `sourceLockfileSha256` 表示源码 checkout 的原锁文件；实际运行依赖以 `environment.lockfileSha256` 的共用版本为准。必须冻结两个构建目录，实验中不能再构建并覆盖静态文件。

烟雾检查可以缩小样本，但报告会保留实际参数，不能把 smoke 结果当正式结论：

```sh
node scripts/perf/browser-benchmark.mjs --samples=1 --observation-ms=1000 --operations=5 --datasets=2000 --profiles=desktop --out=/private/tmp/codetape-perf-smoke.json
```

可以用 `--skip-navigation` 或 `--skip-interactions` 单独重跑一种实验。静态服务使用独立 4601/4602 端口，`/_perf/blank` 只用于计时外播种 IndexedDB，不导入应用脚本。禁用模型请求使用 CDP `Network.setBlockedURLs`，两组相同；没有使用会关闭 HTTP 缓存的 Playwright routing。生产静态服务只模拟匿名账号接口，登录、上传性能不属于此实验。

原始 JSON 包含样本、失败、环境、构建与 lockfile 指纹、数据 checksum、资源字节、最后一个 LCP 元素、业务 ready、DOM 行数、滚动 RAF 间隔、长任务及 Seek 呈现延迟。RAF 间隔不等同于实际 FPS；实验 p75 不等同于线上用户 p75。状态重建对照在 Node 中使用同一个 reducer、快照深克隆及计时外建立的索引；浏览器结果单列，不用函数返回时间冒充代码绘制完成。

默认数据是无媒体合法录制，排除视频解码及 ASR 下载噪声。真实 WebM 使用独立 after-only 组，不和 2k/10k/20k 列表数据混在一起：

```sh
node scripts/perf/browser-benchmark.mjs --after-web-root=/path/to/frozen/performance-dist --media-recording=/private/tmp/codetape-media-fixture/recording.json --media-file=/private/tmp/codetape-media-fixture/media.webm --skip-navigation --operations=100 --out=artifacts/perf/media-seek.json --power-mode=AC
```

媒体组读取由 `record-media-fixture.mjs` 生成的真实 Native MediaRecorder 包与 WebM，并验证原 checksum、真实保存 blobs。只使用隔离浏览器的 fake-device 音视频，不触个人设备。每条原始样本记录 `seeking/seeked`、decoder currentTime/duration/readyState/seekable/buffered、超时及代码呈现时间；`Infinity` 的 decoder 时长如实保留，录制时钟的 duration 不冒充 decoder 实测。100 个测量目标之前有 10 个预热目标，失败也保留。ASR/LLM 推理的性能与质量须由其独立评估报告提供。

参考：[Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)，[Chrome DevTools Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)，[LCP API](https://developer.mozilla.org/en-US/docs/Web/API/LargestContentfulPaint)。
