"""Motion regression tests; CLI outputs are isolated in a temporary directory.

Run: python -B -m unittest discover -s redesign/tools -p test_gen_motions.py -v
"""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

GENERATOR_PATH = Path(__file__).with_name("gen-motions.py")
spec = importlib.util.spec_from_file_location("gen_motions", GENERATOR_PATH)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

ALL_ACTIONS = {"nod", "sway", "shake", "stretch", "wave", "doubt", "fume", "yawn",
               "cheerful_bounce", "shy_sway", "look_around", "daydream", "notice",
               "puff", "kiss", "sob", "deadpan"}

# Exaggerated gaze motions go past the older recipes; these caps are the
# amplitudes measured by `npm run test:bounds` against the 1.30 render margin.
GAZE_LIMITS = {"ParamAngleX": 18, "ParamAngleY": 9, "ParamAngleZ": 8,
               "ParamBodyAngleX": 5.5, "ParamBodyAngleY": 5.5, "ParamBodyAngleZ": 3}
EYE_SAFE = 14  # GazeController.EYE_LIMIT is 20; leave room for expression offsets.
ARM_LIMIT = 3.5  # only notice flinches; well inside shy_sway's measured -10.


def velocities(segments):
    """Yield (time, incoming, outgoing) velocity at every interior key."""
    start = (segments[0], segments[1])
    i, previous_out, result = 2, None, []
    while i < len(segments):
        if segments[i] == 0:
            vin = vout = 0.0
            end = (segments[i + 1], segments[i + 2])
            i += 3
        else:
            t1, v1, t2, v2, t3, v3 = segments[i + 1:i + 7]
            vin = (v1 - start[1]) / (t1 - start[0])
            vout = (v3 - v2) / (t3 - t2)
            end = (t3, v3)
            i += 7
        if previous_out is not None:
            result.append((start[0], previous_out, vin))
        previous_out, start = vout, end
    return result


def endpoints(segments):
    """Decode endpoints independently and count Cubism segments/points."""
    keys, segments_count, points_count = [(segments[0], segments[1])], 0, 1
    i = 2
    while i < len(segments):
        kind = segments[i]
        if kind == 0:
            size, added_points = 3, 1
        elif kind == 1:
            size, added_points = 7, 3
        else:
            raise AssertionError(f"unexpected segment kind {kind}")
        keys.append((segments[i + size - 2], segments[i + size - 1]))
        segments_count += 1
        points_count += added_points
        i += size
    if i != len(segments):
        raise AssertionError("incomplete segment")
    return keys, segments_count, points_count


class SmoothMotionTests(unittest.TestCase):
    def test_intermediate_keys_share_nonzero_velocity_without_overshoot(self):
        keys = [(0, 0), (0.2, -0.6), (0.5, -4), (0.75, -6), (1.8, -6), (2.1, -3), (2.3, 0)]
        segments, count, points = generator.smooth_curve_segments(keys)
        self.assertEqual(count, len(keys) - 1)
        self.assertEqual(endpoints(segments)[1:], (count, points))
        previous_out = None
        start = keys[0]
        i = 2
        for index, end in enumerate(keys[1:]):
            if segments[i] == 0:
                velocity_in = velocity_out = 0
                i += 3
            else:
                t1, v1, t2, v2, t3, v3 = segments[i + 1:i + 7]
                self.assertTrue(start[0] < t1 < t2 < t3)
                self.assertTrue(all(min(start[1], end[1]) <= v <= max(start[1], end[1]) for v in (v1, v2, v3)))
                velocity_in = (v1 - start[1]) / (t1 - start[0])
                velocity_out = (v3 - v2) / (t3 - t2)
                i += 7
            if previous_out is not None:
                self.assertAlmostEqual(previous_out, velocity_in, delta=0.025)
            if index in (1, 2):
                self.assertLess(velocity_in, -1, 'monotone intermediate keys must not stop')
            previous_out = velocity_out
            start = end
        self.assertEqual(previous_out, 0, 'return must ease to rest before neutral tail')

    def test_sway_crosses_center_and_keeps_existing_four_arm_plateau(self):
        curves = {c['Id']: c['Segments'] for c in generator.shy_sway()['Curves']}
        s = curves['ParamBodyAngleZ']
        i = 2
        incoming = outgoing = None
        while i < len(s):
            size = 3 if s[i] == 0 else 7
            if size == 7 and s[i + 5] == 1.06:
                incoming = (s[i + 6] - s[i + 4]) / (s[i + 5] - s[i + 3])
                outgoing = (s[i + size + 2] - s[i + 6]) / (s[i + size + 1] - s[i + 5])
            i += size
        self.assertIsNotNone(incoming)
        self.assertLess(incoming, -1)
        self.assertAlmostEqual(incoming, outgoing, delta=0.01)
        # Forearms keep the exact hidden-hand plateau.
        for pid, value in {'ParamArmL02': -9.8, 'ParamArmR02': -10}.items():
            keys, _, _ = endpoints(curves[pid])
            held = [(time, v) for time, v in keys if 0.6 <= time <= 3.65]
            self.assertEqual(len(held), 2)
            self.assertTrue(all(v == value for _, v in held), pid)
            self.assertGreaterEqual(held[1][0] - held[0][0], 2.8)
            self.assertEqual(keys[-1], (4.2, 0))
        # Upper arms follow the sway but may only squeeze tighter (≤0.6), never loosen.
        for pid, value in {'ParamArmL01': -5.8, 'ParamArmR01': -5.2}.items():
            keys, _, _ = endpoints(curves[pid])
            main = [v for time, v in keys if 0.72 <= time <= 3.62]
            self.assertTrue(main and all(value - 0.6 - 1e-9 <= v <= value + 1e-9 for v in main), pid)
            self.assertEqual(keys[-1], (4.2, 0))

    def test_shy_sway_peek_meets_viewer_then_glances_away_with_blink(self):
        curves = {c['Id']: endpoints(c['Segments'])[0] for c in generator.shy_sway()['Curves']}
        self.assertIn((2.18, 0), curves['ParamEyeBallX'])
        self.assertIn((2.52, -3), curves['ParamEyeBallX'])
        eye = dict(curves['ParamEyeLOpen'])
        self.assertEqual(eye[2.2], 1)
        self.assertEqual(eye[2.48], 0)
        head = dict(curves['ParamAngleY'])
        self.assertGreater(head[2.2], head[1.8])
        self.assertLess(head[2.55], head[2.2])
        # Small counter-lean before the first sway, opposite to the first peak.
        self.assertLess(dict(curves['ParamBodyAngleZ'])[0.22], 0)

    def test_sway_is_stronger_but_head_counterturn_is_subordinate(self):
        curves = {c['Id']: endpoints(c['Segments'])[0] for c in generator.shy_sway()['Curves']}
        self.assertAlmostEqual(max(abs(v) for _, v in curves['ParamBodyAngleZ']), 1.9 * 1.4)
        turns = curves['ParamBodyAngleX'][2:8]
        tilts = curves['ParamBodyAngleZ']
        sway_times = [time for time, _ in tilts if 0.7 <= time <= 3.6 and time != 1.06]
        head = curves['ParamAngleX'][1:7]
        self.assertEqual(len(sway_times), 6)
        for i, ((time, value), sway_time, (head_time, head_value)) in enumerate(zip(turns, sway_times, head)):
            self.assertGreater(sway_time - time, 0.1)
            self.assertLess(sway_time - time, 0.15)
            self.assertTrue(0.7 < abs(value) <= 2.1)
            self.assertLess(value * (1 if i % 2 == 0 else -1), 0)
            self.assertGreater(head_time, sway_time)
            self.assertLess(abs(head_value), abs(value) * 0.4, 'head must not dominate with a large counterturn')
        self.assertEqual(curves['ParamBodyAngleX'][-1], (4.2, 0))

    def test_cheerful_primary_amplitudes_increase_20_to_40_percent_without_new_timing(self):
        motion = generator.cheerful_bounce()
        curves = {c['Id']: endpoints(c['Segments'])[0] for c in motion['Curves']}
        self.assertEqual(motion['Meta']['Duration'], 4.1)
        for pid, old_peak in {'ParamAngleY': 5.5, 'ParamAngleZ': 2,
                              'ParamBodyAngleY': 2.6, 'ParamBodyAngleZ': 1}.items():
            ratio = max(abs(v) for _, v in curves[pid]) / old_peak
            self.assertTrue(1.2 <= ratio <= 1.4, (pid, ratio))
        self.assertIn((0.76, 7.15), curves['ParamAngleY'])
        self.assertIn((1.43, 4.94), curves['ParamAngleY'])
        for pid in ('ParamArmL01', 'ParamArmR01', 'ParamArmL02', 'ParamArmR02'):
            peak = max(abs(v) for _, v in curves[pid])
            self.assertTrue(0 < peak <= 2, 'supporting arm gesture must stay small')
            self.assertEqual(curves[pid][-1], (2.9, 0))


class AllMotionFluidityTests(unittest.TestCase):
    def test_every_motion_is_c1_continuous_and_never_overshoots_its_keys(self):
        for name, recipe in generator.GENERATORS.items():
            for curve in recipe()['Curves']:
                s = curve['Segments']
                for time, vin, vout in velocities(s):
                    # Rounding to 4 decimals bounds the mismatch; no stop-start kinks.
                    self.assertAlmostEqual(vin, vout, delta=0.05, msg=f"{name}/{curve['Id']} @ {time}")
                keys, _, _ = endpoints(s)
                lo, hi = min(v for _, v in keys), max(v for _, v in keys)
                i = 2
                while i < len(s):
                    size = 3 if s[i] == 0 else 7
                    for v in s[i + 2:i + size:2]:
                        self.assertTrue(lo - 1e-9 <= v <= hi + 1e-9, f"{name}/{curve['Id']} overshoot")
                    i += size

    def test_multi_key_head_motions_no_longer_stop_at_intermediate_keys(self):
        # The old per-segment ease halted at every key; only reversals may stop now.
        curves = {c['Id']: c['Segments'] for c in generator.yawn()['Curves']}
        moving = [abs(vin) for _, vin, _ in velocities(curves['ParamMouthOpenY']) if abs(vin) > 0.05]
        self.assertTrue(moving, 'yawn mouth should flow through monotone intermediate keys')


class GazeMotionTests(unittest.TestCase):
    def curves(self, name):
        return {c['Id']: endpoints(c['Segments'])[0] for c in generator.GENERATORS[name]()['Curves']}

    def test_gaze_motions_stay_inside_measured_range_and_eye_limit(self):
        for name in ('look_around', 'daydream', 'notice'):
            curves = self.curves(name)
            for pid, limit in GAZE_LIMITS.items():
                self.assertLessEqual(max(abs(v) for _, v in curves[pid]), limit, (name, pid))
            for pid in ('ParamEyeBallX', 'ParamEyeBallY'):
                self.assertLessEqual(max(abs(v) for _, v in curves[pid]), EYE_SAFE, (name, pid))
            for pid in ('ParamArmL01', 'ParamArmL02', 'ParamArmR01', 'ParamArmR02'):
                self.assertLessEqual(max(abs(v) for _, v in curves[pid]), ARM_LIMIT, (name, pid))
            for pid in ('ParamEyeLSmile', 'ParamEyeRSmile'):
                self.assertLessEqual(max(abs(v) for _, v in curves[pid]), 0.25, (name, pid))

    def test_exaggerated_turns_overshoot_then_settle(self):
        head = dict(self.curves('look_around')['ParamAngleX'])
        self.assertGreater(head[0.2], 0, 'anticipation turns the other way first')
        self.assertLess(head[0.55], head[0.8], 'left turn overshoots before settling')
        self.assertGreater(head[2.0], head[2.25], 'right turn overshoots before settling')

    def test_half_closed_eyes_keep_gaze_small(self):
        # Gaze clamp shrinks with eye openness; keep travel ≤ 20×openness at every key.
        for name in ('look_around', 'daydream', 'notice'):
            curves = self.curves(name)
            eye = dict(curves['ParamEyeLOpen'])
            bx, by = dict(curves['ParamEyeBallX']), dict(curves['ParamEyeBallY'])
            for t, openness in eye.items():
                if t in bx and t in by:
                    self.assertLessEqual((bx[t] ** 2 + by[t] ** 2) ** 0.5, 20 * openness + 1e-9, (name, t))

    def test_look_around_leads_with_eyes_then_head_then_body(self):
        c = self.curves('look_around')
        first_peak = lambda pid: min(t for t, v in c[pid] if abs(v) > 0)
        self.assertLess(first_peak('ParamEyeBallX'), first_peak('ParamAngleX'))
        self.assertLess(first_peak('ParamAngleX'), first_peak('ParamBodyAngleX'))
        self.assertIn((1.6, 0), c['ParamEyeLOpen'], 'blink hides the large saccade')

    def test_notice_is_short_and_leaves_gaze_to_the_pointer(self):
        motion = generator.notice()
        self.assertLessEqual(motion['Meta']['Duration'], 2 + generator.TAIL_SECONDS)
        c = self.curves('notice')
        for pid in ('ParamEyeBallX', 'ParamEyeBallY'):
            self.assertTrue(all(v == 0 for _, v in c[pid]))


class LegacyRemakeTests(unittest.TestCase):
    LEGACY = ('nod', 'sway', 'shake', 'stretch', 'wave', 'doubt', 'fume', 'yawn')
    DURATIONS = {'nod': 3.2, 'sway': 5.6, 'shake': 3.8, 'stretch': 5.0,
                 'wave': 4.2, 'doubt': 4.4, 'fume': 4.2, 'yawn': 5.6}

    def test_durations_unchanged_and_wave_leaves_arms_to_hand_channel(self):
        for name in self.LEGACY:
            motion = generator.GENERATORS[name]()
            self.assertEqual(motion['Meta']['Duration'], self.DURATIONS[name], name)
        wave = {c['Id']: endpoints(c['Segments'])[0] for c in generator.wave()['Curves']}
        for pid in ('ParamArmL01', 'ParamArmL02', 'ParamArmR01', 'ParamArmR02'):
            self.assertTrue(all(v == 0 for _, v in wave[pid]), pid)

    def test_smile_gaze_rule_holds_at_every_key(self):
        # Full smile (≥0.7) keeps eyes centered; light smile (≤0.4) keeps gaze ≤ 5.
        for name in self.LEGACY:
            c = {k['Id']: dict(endpoints(k['Segments'])[0]) for k in generator.GENERATORS[name]()['Curves']}
            smile = c['ParamEyeLSmile']
            for t, s in smile.items():
                for pid in ('ParamEyeBallX', 'ParamEyeBallY'):
                    if t in c[pid]:
                        if s >= 0.7:
                            self.assertEqual(c[pid][t], 0, (name, pid, t))
                        elif s > 0:
                            self.assertLessEqual(abs(c[pid][t]), 5, (name, pid, t))

    def test_arm_gestures_stay_small_and_return(self):
        for name in self.LEGACY:
            for curve in generator.GENERATORS[name]()['Curves']:
                if curve['Id'].startswith('ParamArm'):
                    keys = endpoints(curve['Segments'])[0]
                    self.assertLessEqual(max(abs(v) for _, v in keys), 6.5, (name, curve['Id']))
                    self.assertEqual(keys[-1][1], 0)


class CliTests(unittest.TestCase):
    def test_normal_generator_writes_only_registered_motions_and_preserves_other_recipes(self):
        with tempfile.TemporaryDirectory() as temp:
            motions, dist = Path(temp) / 'motions', Path(temp) / 'dist'
            output = io.StringIO()
            with mock.patch.multiple(generator, MOTIONS_DIR=str(motions), DIST_DIR=str(dist)), contextlib.redirect_stdout(output):
                generator.main()
            expected_names = ALL_ACTIONS
            self.assertEqual(set(generator.GENERATORS), expected_names)
            expected_stdout = ''
            for name, recipe in generator.GENERATORS.items():
                payload = (motions / f'{name}.motion3.json').read_bytes()
                self.assertEqual(payload, (dist / f'{name}.motion3.json').read_bytes())
                data = json.loads(payload)
                self.assertEqual(data, recipe())
                meta = data['Meta']
                counts = [endpoints(c['Segments'])[1:] for c in data['Curves']]
                self.assertEqual(meta['CurveCount'], 30)
                self.assertEqual(meta['TotalSegmentCount'], sum(s for s, _ in counts))
                self.assertEqual(meta['TotalPointCount'], sum(p for _, p in counts))
                expected_stdout += (f"{name}: dur={meta['Duration']} curves={meta['CurveCount']} "
                                    f"segs={meta['TotalSegmentCount']} pts={meta['TotalPointCount']}\n")
            self.assertEqual(output.getvalue(), expected_stdout)
            for directory in (motions, dist):
                self.assertEqual({p.stem.removesuffix('.motion3') for p in directory.iterdir()}, expected_names)


if __name__ == '__main__':
    unittest.main()
