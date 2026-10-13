export const prototypeScenes = [
  { id: 'home', label: '首页' },
  { id: 'create', label: '创建房间' },
  { id: 'waiting', label: '等待房间' },
  { id: 'table', label: '游戏牌桌' },
  { id: 'result', label: '结算' },
] as const;

export type SceneId = (typeof prototypeScenes)[number]['id'];

export function isSceneId(value: string): value is SceneId {
  return prototypeScenes.some((scene) => scene.id === value);
}

export function sceneFromHash(hash: string): SceneId {
  const value = hash.replace(/^#\/?/, '');
  return isSceneId(value) ? value : 'home';
}
