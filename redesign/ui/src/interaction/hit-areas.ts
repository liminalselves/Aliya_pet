/**
 * 互动区域（移植自 Flutter HitAreaService）：
 * 固定模型参考视口中的椭圆区域，按优先级取命中。
 * PetApp 先反解实际渲染变换，再按 referenceRenderMargin 换算到本坐标系。
 */

import { assetUrl } from '../embed';

export interface HitAreaDefinition {
  id: string;
  type: string; // 当前仅支持 ellipse
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
}

function contains(
  area: HitAreaDefinition,
  nx: number,
  ny: number,
  mirrored: boolean
): boolean {
  const x = mirrored ? 1 - nx : nx;
  const dx = (x - area.x) / (area.width / 2);
  const dy = (ny - area.y) / (area.height / 2);
  return dx * dx + dy * dy <= 1;
}

export class HitAreas {
  private _areas: HitAreaDefinition[] = [];
  private _headPetZone: HitAreaDefinition | null = null;
  /** 配置校准时的视口余量，不随当前渲染余量变化。 */
  referenceRenderMargin = 1;

  /** 是否镜像（左右互换）。 */
  mirrored = false;

  async load(url = assetUrl('/interaction/aliya_hit_areas.json')): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const doc = await res.json();
      if (!doc || !Array.isArray(doc.areas)) return;
      if (doc.coordinateSpace !== 'model_reference_normalized' ||
        !Number.isFinite(doc.referenceRenderMargin) || doc.referenceRenderMargin <= 0) return;
      this.referenceRenderMargin = doc.referenceRenderMargin;
      this._areas = [];
      this._headPetZone = null;
      for (const m of doc.areas) {
        const def: HitAreaDefinition = {
          id: String(m.id ?? ''),
          type: String(m.type ?? 'ellipse'),
          x: Number(m.x ?? 0.5),
          y: Number(m.y ?? 0.5),
          width: Number(m.width ?? 0.3),
          height: Number(m.height ?? 0.3),
          priority: Number(m.priority ?? 0),
        };
        if (!def.id) continue;
        this._areas.push(def);
        if (def.id === 'head_pet_zone') this._headPetZone = def;
      }
    } catch {
      // 配置缺失：互动区域全部失活
    }
  }

  get areas(): readonly HitAreaDefinition[] {
    return this._areas;
  }

  /** 归一化点命中的最高优先级区域 ID；未命中返回 null。 */
  hitAreaAt(nx: number, ny: number): string | null {
    let best: HitAreaDefinition | null = null;
    for (const area of this._areas) {
      if (contains(area, nx, ny, this.mirrored)) {
        if (!best || area.priority > best.priority) best = area;
      }
    }
    return best?.id ?? null;
  }

  isInArea(id: string, nx: number, ny: number): boolean {
    const area = this._areas.find((a) => a.id === id);
    return area != null && contains(area, nx, ny, this.mirrored);
  }

  isInHeadPetZone(nx: number, ny: number): boolean {
    return (
      this._headPetZone != null &&
      contains(this._headPetZone, nx, ny, this.mirrored)
    );
  }
}
