// three.js 객체 트리의 GPU 자원 해제 (geometry · material · texture)
//  씬에서 떼어 내는 것만으로는 WebGL 버퍼가 남는다 — 로봇·그리퍼·셀을 바꿀 때마다 메모리가 늘지 않도록 정리.
//  해제한 자원을 나중에 다시 쓰면 three.js 가 자동으로 다시 올리므로, 공유 재질이어도 안전하다.
export function disposeTree(root) {
  if (!root) return;
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose?.();
    }
  });
}

// 그룹의 자식을 모두 해제하고 비움
export function clearGroup(group) {
  for (const c of [...group.children]) disposeTree(c);
  group.clear();
}
