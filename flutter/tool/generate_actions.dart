// 鐢熸垚 Hiyori 妯″瀷鐨?16 涓姩浣滐紙鑷畾涔?keyframes 鏍煎紡锛屽惈鎵嬭噦/鎵?鑵匡級銆?
// 杩愯: dart run tool/generate_actions.dart
import 'dart:convert';
import 'dart:io';

typedef Kf = ({double t, double v, String e});
typedef Ch = ({String p, double w, List<Kf> k});

Kf k(double t, double v, [String e = 'easeInOut']) => (t: t, v: v, e: e);
Ch c(String p, double w, List<Kf> k) => (p: p, w: w, k: k);

void main() {
  final actions = <String, List<Ch>>{
    'idle': [
      c('ParamBreath', 0.3, [k(0, 0, 'easeOut'), k(2, 1), k(4, 0, 'easeOut')]),
      c('ParamBodyAngleZ', 0.2, [k(0, 0), k(2, -2), k(4, 2), k(6, 0)]),
      c('ParamEyeLOpen', 0.8, [k(0, 1), k(1.5, 1), k(1.7, 0.1), k(1.9, 1), k(4, 1)]),
      c('ParamEyeROpen', 0.8, [k(0, 1), k(1.5, 1), k(1.7, 0.1), k(1.9, 1), k(4, 1)]),
    ],
    'wave': [
      c('PartArmB', 1.0, [k(0, 1), k(2.2, 1)]),
      c('PartArmA', 1.0, [k(0, 0), k(2.2, 0)]),
      c('ParamArmRA', 0.9, [k(0, 0, 'easeOut'), k(0.3, -10), k(1.6, -10), k(2.2, 0, 'easeOut')]),
      c('ParamArmRB', 0.9, [k(0.3, 0), k(0.6, 6), k(1.0, -6), k(1.4, 6), k(1.8, -6), k(2.2, 0)]),
      c('ParamHandR', 0.7, [k(0.3, 0), k(0.6, 4), k(1.4, -4), k(2.2, 0)]),
      c('ParamAngleZ', 0.4, [k(0, 0), k(0.6, -6), k(1.2, 5), k(1.8, -4), k(2.2, 0)]),
      c('ParamBrowLY', 0.4, [k(0, 0), k(0.4, 0.3), k(1.8, 0.2), k(2.2, 0)]),
    ],
    'nod': [
      c('ParamAngleY', 0.9, [k(0, 0), k(0.25, -14), k(0.5, 4), k(0.75, -14), k(1.0, 4), k(1.2, -10), k(1.4, 0, 'easeOut')]),
      c('ParamBrowLY', 0.4, [k(0, 0), k(0.3, 0.2), k(1.2, 0.15), k(1.4, 0)]),
      c('ParamBrowRY', 0.4, [k(0, 0), k(0.3, 0.2), k(1.2, 0.15), k(1.4, 0)]),
    ],
    'stretch': [
      c('PartArmB', 1.0, [k(0, 1), k(2.2, 1)]),
      c('PartArmA', 1.0, [k(0, 0), k(2.2, 0)]),
      c('ParamShoulder', 0.8, [k(0, 0), k(0.4, 15), k(1.4, 15), k(2.0, 0, 'easeOut')]),
      c('ParamArmLA', 0.8, [k(0, 0), k(0.5, -25), k(1.6, -10), k(2.2, 0, 'easeOut')]),
      c('ParamArmRA', 0.8, [k(0, 0), k(0.5, -25), k(1.6, -10), k(2.2, 0, 'easeOut')]),
      c('ParamArmLB', 0.8, [k(0, 0), k(0.6, -6), k(1.6, -6), k(2.2, 0, 'easeOut')]),
      c('ParamArmRB', 0.8, [k(0, 0), k(0.6, -6), k(1.6, -6), k(2.2, 0, 'easeOut')]),
      c('ParamMouthOpenY', 0.7, [k(0, 0), k(0.5, 0.6), k(1.4, 0.3), k(2.2, 0)]),
      c('ParamEyeLOpen', 0.5, [k(0, 1), k(0.5, 0.3), k(1.6, 0.5), k(2.2, 1)]),
      c('ParamEyeROpen', 0.5, [k(0, 1), k(0.5, 0.3), k(1.6, 0.5), k(2.2, 1)]),
    ],
    'yawn': [
      c('ParamMouthOpenY', 0.9, [k(0, 0), k(0.5, 0.9), k(1.3, 0.7), k(2.0, 0.2), k(2.6, 0, 'easeOut')]),
      c('ParamEyeLOpen', 0.6, [k(0, 1), k(0.5, 0.3), k(1.6, 0.4), k(2.6, 1)]),
      c('ParamEyeROpen', 0.6, [k(0, 1), k(0.5, 0.3), k(1.6, 0.4), k(2.6, 1)]),
      c('ParamBodyAngleX', 0.4, [k(0, 0), k(0.8, 5), k(1.8, 4), k(2.6, 0)]),
      c('ParamArmRA', 0.4, [k(0, 0), k(0.6, 6), k(1.6, 5), k(2.6, 0)]),
    ],
    'shake': [
      c('ParamAngleZ', 0.9, [k(0, 0), k(0.15, -15), k(0.3, 15), k(0.45, -15), k(0.6, 15), k(0.75, -15), k(0.9, 15), k(1.05, -10), k(1.2, 0, 'easeOut')]),
      c('ParamBrowLAngle', 0.5, [k(0, 0), k(0.2, -12), k(1.0, -12), k(1.2, 0)]),
      c('ParamBrowRAngle', 0.5, [k(0, 0), k(0.2, -12), k(1.0, -12), k(1.2, 0)]),
    ],
    'sway': [
      c('ParamBodyAngleZ', 0.8, [k(0, 0), k(0.4, 10), k(0.8, -10), k(1.2, 8), k(1.6, -8), k(2.0, 0, 'easeOut')]),
      c('ParamArmLA', 0.5, [k(0, 0), k(0.4, -5), k(1.2, 5), k(2.0, 0)]),
      c('ParamArmRA', 0.5, [k(0, 0), k(0.4, 5), k(1.2, -5), k(2.0, 0)]),
      c('ParamHairBack', 0.4, [k(0, 0), k(0.4, 5), k(1.2, -5), k(2.0, 0)]),
      c('ParamEyeLSmile', 0.5, [k(0, 0), k(0.4, 1), k(1.6, 0.8), k(2.0, 0)]),
      c('ParamEyeRSmile', 0.5, [k(0, 0), k(0.4, 1), k(1.6, 0.8), k(2.0, 0)]),
    ],
    'angry': [
      c('ParamBrowLAngle', 0.9, [k(0, 0), k(0.3, -10), k(1.4, -25), k(2.0, 0, 'easeOut')]),
      c('ParamBrowRAngle', 0.9, [k(0, 0), k(0.3, -10), k(1.4, -25), k(2.0, 0, 'easeOut')]),
      c('ParamBrowLForm', 0.7, [k(0, 0), k(0.3, -1), k(1.4, -1), k(2.0, 0)]),
      c('ParamBrowRForm', 0.7, [k(0, 0), k(0.3, -1), k(1.4, -1), k(2.0, 0)]),
      c('ParamMouthForm', 0.7, [k(0, 0), k(0.3, 0.8), k(1.4, 0.6), k(2.0, 0)]),
      c('ParamCheek', 0.6, [k(0, 0), k(0.3, 0.8), k(1.4, 0.7), k(2.0, 0)]),
      c('ParamAngleZ', 0.4, [k(0, 0), k(0.4, -6), k(1.4, -5), k(2.0, 0)]),
    ],
    'doubt': [
      c('ParamAngleZ', 0.8, [k(0, 0), k(0.4, 12), k(1.6, 12), k(2.2, 0, 'easeOut')]),
      c('ParamBrowLY', 0.8, [k(0, 0), k(0.4, 0.8), k(1.6, 0.7), k(2.2, 0)]),
      c('ParamBrowRY', 0.8, [k(0, 0), k(0.4, 0.8), k(1.6, 0.7), k(2.2, 0)]),
      c('ParamEyeLOpen', 0.6, [k(0, 1), k(0.4, 0.8), k(1.6, 0.8), k(2.2, 1)]),
      c('ParamEyeROpen', 0.6, [k(0, 1), k(0.4, 0.8), k(1.6, 0.8), k(2.2, 1)]),
      c('ParamMouthOpenY', 0.5, [k(0, 0), k(0.4, 0.3), k(1.6, 0.2), k(2.2, 0)]),
    ],
    'click': [
      c('ParamBodyAngleY', 0.8, [k(0, 0), k(0.12, -6, 'easeOut'), k(0.24, 0, 'easeIn'), k(0.36, -4, 'easeOut'), k(0.48, 0, 'easeIn')]),
      c('ParamEyeLOpen', 0.8, [k(0, 1), k(0.1, 0.2), k(0.2, 1), k(0.3, 0.3), k(0.4, 1)]),
      c('ParamEyeROpen', 0.8, [k(0, 1), k(0.1, 0.2), k(0.2, 1), k(0.3, 0.3), k(0.4, 1)]),
      c('ParamMouthOpenY', 0.6, [k(0, 0), k(0.1, 0.4), k(0.3, 0.3), k(0.5, 0)]),
      c('ParamCheek', 0.5, [k(0, 0), k(0.15, 0.6), k(0.45, 0.4), k(0.6, 0)]),
    ],
    'drag': [
      c('PartArmB', 1.0, [k(0, 1), k(2.2, 1)]),
      c('PartArmA', 1.0, [k(0, 0), k(2.2, 0)]),
      c('ParamBodyAngleX', 0.8, [k(0, 0), k(0.4, -12), k(1.6, -12), k(2.2, 0, 'easeOut')]),
      c('ParamAngleX', 0.6, [k(0, 0), k(0.4, 10), k(1.6, 9), k(2.2, 0)]),
      c('ParamArmLA', 0.6, [k(0, 0), k(0.5, 8), k(1.6, 7), k(2.2, 0)]),
      c('ParamArmRA', 0.6, [k(0, 0), k(0.5, 8), k(1.6, 7), k(2.2, 0)]),
      c('ParamEyeLOpen', 0.5, [k(0, 1), k(0.5, 0.5), k(1.6, 0.6), k(2.2, 1)]),
      c('ParamEyeROpen', 0.5, [k(0, 1), k(0.5, 0.5), k(1.6, 0.6), k(2.2, 1)]),
    ],
    'fall': [
      c('PartArmB', 1.0, [k(0, 1), k(1.4, 1)]),
      c('PartArmA', 1.0, [k(0, 0), k(1.4, 0)]),
      c('ParamBodyAngleX', 0.9, [k(0, 0), k(0.3, -28, 'easeIn'), k(1.0, -28), k(1.4, 0, 'easeOut')]),
      c('ParamArmLA', 0.7, [k(0, 0), k(0.3, 10, 'easeIn'), k(0.9, 8), k(1.4, 0)]),
      c('ParamArmRA', 0.7, [k(0, 0), k(0.3, -10, 'easeIn'), k(0.9, -8), k(1.4, 0)]),
      c('ParamArmLB', 0.6, [k(0, 0), k(0.35, 6, 'easeIn'), k(0.9, 5), k(1.4, 0)]),
      c('ParamArmRB', 0.6, [k(0, 0), k(0.35, -6, 'easeIn'), k(0.9, -5), k(1.4, 0)]),
      c('ParamEyeLOpen', 0.6, [k(0, 1), k(0.25, 0.2, 'easeIn'), k(1.0, 0.3), k(1.4, 1)]),
      c('ParamEyeROpen', 0.6, [k(0, 1), k(0.25, 0.2, 'easeIn'), k(1.0, 0.3), k(1.4, 1)]),
      c('ParamMouthOpenY', 0.5, [k(0, 0), k(0.3, 0.5, 'easeIn'), k(1.0, 0.4), k(1.4, 0)]),
    ],
    'land': [
      c('ParamBodyAngleY', 0.8, [k(0, -8, 'easeOut'), k(0.15, 0, 'easeIn'), k(0.3, -5, 'easeOut'), k(0.45, 0, 'easeIn')]),
      c('ParamBodyAngleX', 0.6, [k(0, -15), k(0.15, 0), k(0.4, 0)]),
      c('ParamArmLA', 0.6, [k(0, 12), k(0.2, 0), k(0.5, 0)]),
      c('ParamArmRA', 0.6, [k(0, -12), k(0.2, 0), k(0.5, 0)]),
      c('ParamEyeLOpen', 0.6, [k(0, 0.3), k(0.2, 1), k(0.5, 1)]),
      c('ParamEyeROpen', 0.6, [k(0, 0.3), k(0.2, 1), k(0.5, 1)]),
    ],
    'edge_idle': [
      c('ParamAngleZ', 0.5, [k(0, 0), k(1.5, 8), k(3.0, 8), k(4.5, 0, 'easeOut')]),
      c('ParamBodyAngleZ', 0.4, [k(0, 0), k(1.5, 5), k(3.0, 5), k(4.5, 0)]),
      c('ParamBreath', 0.3, [k(0, 0), k(2, 1), k(4, 0)]),
      c('ParamEyeLOpen', 0.8, [k(0, 1), k(2, 1), k(2.2, 0.1), k(2.4, 1), k(4.5, 1)]),
      c('ParamEyeROpen', 0.8, [k(0, 1), k(2, 1), k(2.2, 0.1), k(2.4, 1), k(4.5, 1)]),
    ],
    'walk_left': [
      c('ParamLeg', 0.9, [k(0, 0), k(0.2, 20), k(0.4, 0), k(0.6, -20), k(0.8, 0), k(1.0, 20), k(1.2, 0)]),
      c('ParamBodyAngleX', 0.6, [k(0, 0), k(0.3, -6), k(0.6, 6), k(0.9, -6), k(1.2, 0)]),
      c('ParamArmLA', 0.6, [k(0, 0), k(0.2, 8), k(0.6, -8), k(1.0, 8), k(1.2, 0)]),
      c('ParamArmRA', 0.6, [k(0, 0), k(0.2, -8), k(0.6, 8), k(1.0, -8), k(1.2, 0)]),
      c('ParamHairBack', 0.5, [k(0, 0), k(0.3, 10), k(0.9, -10), k(1.2, 0)]),
    ],
    'walk_right': [
      c('ParamLeg', 0.9, [k(0, 0), k(0.2, -20), k(0.4, 0), k(0.6, 20), k(0.8, 0), k(1.0, -20), k(1.2, 0)]),
      c('ParamBodyAngleX', 0.6, [k(0, 0), k(0.3, 6), k(0.6, -6), k(0.9, 6), k(1.2, 0)]),
      c('ParamArmLA', 0.6, [k(0, 0), k(0.2, -8), k(0.6, 8), k(1.0, -8), k(1.2, 0)]),
      c('ParamArmRA', 0.6, [k(0, 0), k(0.2, 8), k(0.6, -8), k(1.0, 8), k(1.2, 0)]),
      c('ParamHairBack', 0.5, [k(0, 0), k(0.3, -10), k(0.9, 10), k(1.2, 0)]),
    ],
  };

  final outDir = Directory(
      '${Directory.current.path}/assets/live2d/Hiyori/Actions');
  outDir.createSync(recursive: true);

  actions.forEach((name, channels) {
    double duration = 0;
    for (final ch in channels) {
      for (final kf in ch.k) {
        if (kf.t > duration) duration = kf.t;
      }
    }
    final doc = {
      'id': name,
      'duration': double.parse(duration.toStringAsFixed(2)),
      'priority': 40,
      'interruptible': true,
      'blendIn': 0.1,
      'blendOut': 0.2,
      'tags': [name],
      'channels': [
        for (final ch in channels)
          {
            'parameter': ch.p,
            'blendMode': 'override',
            'weight': ch.w,
            'keyframes': [
              for (final kf in ch.k)
                {'time': kf.t, 'value': kf.v, 'easing': kf.e},
            ],
          },
      ],
    };
    final file = File('${outDir.path}/$name.json');
    file.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert(doc),
        encoding: utf8);
    print('鐢熸垚: $name.json (duration=${doc['duration']}s, '
        'channels=${channels.length})');
  });
  print('瀹屾垚: ${actions.length} 涓姩浣?-> ${outDir.path}');
}
