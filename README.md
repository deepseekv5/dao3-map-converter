# DAO3 地图转换器

把**神岛（DAO3）**导出的地图 `.zip` 转成 **BOX3 Local Engine** 能直接使用的两种格式：

| 产物 | 用途 |
| --- | --- |
| `.boxproject` | 导入**创作端**编辑地形、脚本、模型 |
| `.boxplay` | 放进**游玩库**直接运行 |

**网页版（无需安装）**：https://deepseekv5.github.io/dao3-map-converter/
打开就能用，文件全程留在浏览器里，不上传任何服务器。

也可以本地跑：不需要 Docker、不需要数据库、不需要平台账号，只要 Node.js 18+。

## 为什么做这个

神岛平台关闭后，大量老地图的导出包散落各处。这些包有几类问题：

- 格式和官方引擎不兼容（`block.json` vs `config/`）
- 缺文件（体素、脚本、模型、配置）
- 引用了已消失的云端资源

这个工具把它们**尽可能还原成可编辑、可游玩的工程**，缺什么会在结果里如实说明，不静默丢数据。

## 两种用法

### 网页版（推荐，零安装）

直接打开 https://deepseekv5.github.io/dao3-map-converter/ ，拖入 zip 即可。

- 全部计算在浏览器里完成（`crypto.subtle` 算哈希、`DecompressionStream` 解压、
  纯 JS 生成 tar.gz），文件**不会上传**
- 支持拖拽多选、进度反馈、工程包/游玩包双下载
- 可外挂 `entitiesTree.json` 补回场景实体
- 引擎运行时资源内置，产出的工程可直接在创作端打开

### 命令行

```bash
./run.sh                      # 起界面（浏览器打开 http://127.0.0.1:8801/）
./run.sh 地图.zip              # 命令行直接转
./run.sh a.zip b.zip          # 批量
```

产出默认写到 `~/Desktop/DAO3转换产出/`，可改：

```bash
DAO3_CONV_OUT=~/我的产出 ./run.sh 地图.zip
```

macOS 可双击 `启动转换器.command`。

## 支持两种导出包

| | 老导出包 | 官方新导出 |
| --- | --- | --- |
| 工程信息 | `block.json` + `json/*.json` | `<proj>/config/*.json` + `meta/` |
| 体素 | `terrain/voxel-sparse.gz` | 同名，zip 根 |
| 脚本 | `scripts/*.js` | `assets/scripts/{server,client,other}/` |
| 图片 | `images/<子路径>` | `public/images/` |
| 音频 | `audio/` | `public/audios/` |
| 模型 | `meshes/*.vox` | `public/models/<名>/{json,bin,gltf}` |

**地图组**（一个 zip 含多张地图）会自动拆开，逐张产出。

还支持一种精简导出格式：`project/project.json` + `build/voxel-sparse.gz` +
`code/*.js` + `models/*.gltf`。这种包通常缺配置文档和实体树，转换器会从
`export-manifest.json` / `project/map.json` 取地图 ID，并用 `--entities` 补实体。

## 转换了什么

- **体素地形** — `voxel-sparse.gz` 或 `terrain/raw` 区块 → 引擎 chunk，方块朝向完整保留
- **脚本** — 服务端 / 客户端 / 其它，三类全部保留
- **模型**
  - 官方 VOXA（`json` + `bin`）→ 原生迁移链路
  - MagicaVoxel `.vox` → 转成 VOXA 格式（含 z-up→y-up 轴变换）
  - glTF → 登记并计算包围盒
- **场景实体** — `json/entities.json` 里的放置物（机关、道具、建筑）→ 引擎实体树
- **图片 / 音频 / UI / 环境** — 全部保留，含尺寸元数据

## 用法细节

### 导入创作端

1. 启动 BOX3 Local Engine（官方 Docker 部署）
2. 打开创作端，点「导入工程」
3. 选 `.boxproject`

### 补回丢失的场景实体

有些导出工具只导模型和地形，把场景里摆放的物件（`entitiesTree`）单独存成文件。
这时用 `--entities` 指定它，即可把位置、朝向、物理参数全部接回来：

```bash
./run.sh --entities /path/to/entitiesTree.json 地图.zip
```

判断方法：打开 `.boxproject` 的实体树，若实体数为 0 而原地图里明明摆了很多东西，
就是这个情况。实体树里的 `mesh` 路径与转换出的模型 key 一致时才能对应上。

### 放进游玩库

```bash
tar -xzf 地图.boxplay -C /tmp/bp
mv /tmp/bp/worlds/* <游玩库>/
```

引擎会把它当成一个世界直接加载。

### 让模型出现在编辑器面板

转换出的模型会进入工程的 `assets`（场景能显示），但编辑器的 Models 面板读的是 **VOXA 本地库**，需要额外同步一次：

```bash
node push-models.mjs --project <工程目录>            # 自动读取 cloudMapId
node push-models.mjs --all <游玩库目录>              # 批量
```

`cloudMapId` 取自原包的 `meta/mapId.txt`，编辑器按它查找模型——这也是为什么转换时要保留原地图 ID。

## 质量检查

每次转换后可以验证产物的正确性——检查项对应引擎真实读取路径，不是形式化清单：

```bash
node verify-output.mjs --all ~/Desktop/DAO3转换产出
```

覆盖 8 类检查：

| 检查 | 内容 |
| --- | --- |
| 归档外壳 | tar.gz 可解、顶层结构符合官方要求 |
| 文档链自洽 | permission → versionControl → project 全部可达 |
| 资源完整性 | 文档引用的每个 blob 都存在 |
| 体素完整性 | chunk 数 = ⌈shape/32⌉ 乘积，逐块存在 |
| 模型可解析 | VOXA 元数据含 version/bounds/dataHash，dataHash 可读 |
| 实体引用 | 实体树里的 mesh 路径都在 assets 中 |
| 运行时资源 | 客户端脚本包 + runtime-blobs.json 齐备 |
| cloudMapId | 编辑器模型面板可见性 |

实测 20 个导出包、64 个产物（工程包 + 游玩包）全部通过。

## 已知限制

- **`.vox` 转 VOXA**：几何与调色板正确，会生成标准 `{version,bounds,dataHash}` 元数据；不支持 MagicaVoxel 的高级材质（PBR 参数）
- **缺失模型**：实体引用了包内没有的模型时，会生成 1×1×1 占位方块并在结果里注明
- **模型的预览图**：官方导出包里没有预览图字段，无法凭空生成
- **图片资产**：引擎要求特定元数据形状，转换器会生成；但封面/横幅引用若原包里确实没有图片，会被清空
- **脚本**：如果原包的玩法逻辑在未导出的 bundle 里（部分包只带 `require('./_server_bundle.js')`），那部分代码不在包内，无法还原

## 依赖

- Node.js 18+（推荐 20 / 22）
- 系统 `tar`（macOS / Linux 自带）
- 零 npm 依赖

`runtime/` 里内置了引擎运行时资源（约 22MB），保证产出的工程在编辑器里能启动——不内置的话会报 `Runtime assets are incomplete`。

## 目录

```
converter/
├── convert.mjs          核心转换（zip → blob 图 → 工程/游玩包）
├── server.mjs           本地 Web 服务
├── run.sh               启动 / 命令行
├── push-models.mjs      同步模型到 VOXA 库
├── fix-imported.mjs     修复已导入的旧工程
├── verify-output.mjs    产物质量检查（结构/自洽性/资源完整性）
├── lib/                 体素编码、图片尺寸、glTF、vox 转换
├── web/                 界面（本地服务版）
├── web/browser/         网页版（纯静态，GitHub Pages 用）
└── runtime/             内置引擎运行时资源
```

## 许可

MIT。转换产物（.boxproject / .boxplay）的版权归原地图作者所有，本工具只做格式转换。
