let activations = 0;

/** 仅隔离原 Loader 的故障注入：源声明正常，复制的新组成激活失败，用于验证原文件/目录回滚。 */
export function apply() {
  if (++activations > 1) throw Error('isolated_preset_copy_activation_failed');
}
