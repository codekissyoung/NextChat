#!/bin/bash

# ReACT功能测试脚本

echo "🧪 测试NextChat ReACT功能"
echo "================================"

# 测试用例：让AI自动调用工具回答问题
curl -X POST http://localhost:3000/api/react \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-k2-0905-preview",
    "messages": [
      {
        "role": "user",
        "content": "请告诉我现在的时间，以及当前目录有哪些文件？"
      }
    ]
  }' | jq '.'

echo ""
echo "✅ 测试完成！查看上面的响应"
echo ""
echo "📝 预期行为："
echo "1. AI会自动调用 current_time 和 list_files 工具"
echo "2. 工具执行后，AI会综合结果回答你的问题"
echo "3. 查看终端日志可以看到 [ReACT API] 的执行过程"
echo ""
echo "💡 说明：现在使用独立的 /api/react 端点，不影响原有聊天功能"
