import type {
  OB11MessageData,
  OB11Message,
} from 'napcat-types/napcat-onebot';

// ==================== 插件配置 ====================

export interface PluginConfig {
  enabled: boolean;
  debug: boolean;
  commandPrefix: string;
  collectorMode: boolean;
  groupConfigs: Record<string, GroupConfig>;
}

export interface GroupConfig {
  enabled?: boolean;
}

// ==================== 类型别名 ====================

/** 合并转发节点（get_forward_msg 返回的消息节点） */
export interface ForwardNode {
  type: 'node';
  data: {
    user_id?: string;
    nickname?: string;
    content?: OB11MessageData[];
    message?: OB11MessageData[];
  };
}

/** 展开后的转发内容 */
export interface ForwardContent {
  messages: ForwardNode[];
}

/** 转发分析摘要 */
export interface ForwardAnalysis {
  totalMessages: number;
  totalImages: number;
  totalNestedForwards: number;
  maxDepth: number;
  senders: string[];
  hasNested: boolean;
}

// ==================== 保存相关 ====================

/** 单条消息的保存格式 */
export interface SavedMessage {
  index: number;
  sender: {
    userId?: string;
    nickname?: string;
  };
  time?: number;
  segments: OB11MessageData[];
}

/** 已保存转发的完整结构 */
export interface SavedForward {
  savedAt: string;
  source: {
    fromGroup?: string;
    fromUser?: string;
  };
  totalMessages: number;
  totalImages: number;
  images: Array<{
    index: number;
    sender: string;
    url: string;
    fileSize?: string;
  }>;
  messages: SavedMessage[];
}
