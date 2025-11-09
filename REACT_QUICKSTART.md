# 🚀 NextChat ReACT 快速开始

## ✅ 已完成
1. ✅ Shell工具白名单（app/tools/shell.ts）
2. ✅ ReACT循环逻辑（app/api/moonshot.ts）
3. ✅ 测试脚本（test-react.sh）

## 🧪 立即测试

### 1. 启动开发服务器
```bash
yarn dev
```

### 2. 运行测试（新终端）
```bash
./test-react.sh
```

### 3. 观察日志
在`yarn dev`的终端查看：
```
[ReACT] Starting with messages: 1
[ReACT] Iteration 1/3
[ReACT] Executing tool: current_time
[ReACT] Tool result: 2025年11月4日...
[ReACT] Executing tool: list_files
[ReACT] Tool result: total 2.3M...
[ReACT] No tool calls, returning final answer
```

## 📊 预期结果

**输入：** "请告诉我现在的时间，以及当前目录有哪些文件？"

**ReACT流程：**
1. 🤔 AI分析：需要调用 `current_time` 和 `list_files`
2. ⚙️  执行工具：获取时间 + 列出文件
3. 💡 AI综合：根据工具结果生成回答

**输出示例：**
```
现在的时间是 2025年11月4日 星期一 22:30:45 CST。

当前目录包含以下文件：
- Dockerfile (1.2KB)
- README.md (17KB)
- package.json (3.4KB)
- yarn.lock (350KB)
...
```

## 🛠️ 可用工具

当前白名单（安全的只读命令）：
- `list_files` - 列出当前目录文件
- `current_directory` - 显示工作目录路径
- `current_time` - 获取系统时间

## 🔧 添加新工具

编辑 `app/tools/shell.ts`：
```typescript
const SAFE_COMMANDS: Record<string, string[]> = {
  list_files: ['ls', '-lh'],
  // 添加你的工具
  check_disk: ['df', '-h'],
};
```

## 🎯 价值展示案例

### 案例1：系统信息收集
**提问：** "帮我检查服务器状态：磁盘空间、内存使用、当前目录"

**AI自动执行：**
- `disk_usage` → 磁盘空间
- `memory_info` → 内存信息
- `current_directory` → 工作路径

### 案例2：文件分析
**提问：** "当前目录有多少个TypeScript文件？"

**AI流程：**
1. 调用 `list_files` 获取文件列表
2. 分析结果，统计`.ts`文件数量
3. 返回答案

## 📈 下一步

1. **添加更多工具** - Python脚本执行、Git操作等
2. **前端集成** - 在UI中启用工具调用
3. **长时任务** - 添加任务队列支持
4. **Docker部署** - 打包成容器

## 🚨 安全提示

当前实现：
- ✅ 命令白名单限制
- ✅ 执行超时保护
- ✅ 输出大小限制
- ⚠️  本地运行，未隔离

生产环境建议：
- Docker沙箱隔离
- 审计日志记录
- 权限细化控制
