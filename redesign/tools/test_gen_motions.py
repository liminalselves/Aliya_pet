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

# Preserve all eight unrelated recipes, including the existing eye fixes.
UNCHANGED_SHA256 = {
    "nod": "95347b8c15e947d616959f36976d078092f8a72f49e560e08bd83570b88e677e",
    "sway": "5fcc57e9ec7746dac662512d37a13bbf6bf501a4527d387ad646358bd691a768",
    "shake": "c9f0a65a8ffd18324e8058a6e1196f003d28cfeb1ea52273b9d8cd1e727b83d8",
    "stretch": "d7510d980f2b278743f5ed8323cdfb38290809b71fc18a875b2eeb016d734ea6",
    "wave": "2c1225dddc11068c9576a06f91d0b9e13a1a90e5bcdd58603977f2de13291c92",
    "doubt": "658c6df418cf6155a9e3bf5d711866cd6cc8c1a071d7011ae951e92f8a577afc",
    "angry": "73c08f5ebf92c2e58f9e765640b160a936ff3f44cfe03a6ed4d5b75d6069475e",
    "yawn": "7ed97cbad4c3e1c5eb367d3b3e7f9345f5c86d9b5c3cb1a7eace0e2f3180a52a",
}


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
        for pid, value in {'ParamArmL01': -5.8, 'ParamArmR01': -5.2,
                           'ParamArmL02': -9.8, 'ParamArmR02': -10}.items():
            keys, _, _ = endpoints(curves[pid])
            held = [(time, v) for time, v in keys if 0.6 <= time <= 3.65]
            self.assertEqual(len(held), 2)
            self.assertTrue(all(v == value for _, v in held), pid)
            self.assertGreaterEqual(held[1][0] - held[0][0], 2.8)
            self.assertEqual(keys[-1], (4.2, 0))

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


class CliTests(unittest.TestCase):
    def test_normal_generator_writes_only_registered_motions_and_preserves_other_recipes(self):
        with tempfile.TemporaryDirectory() as temp:
            motions, dist = Path(temp) / 'motions', Path(temp) / 'dist'
            output = io.StringIO()
            with mock.patch.multiple(generator, MOTIONS_DIR=str(motions), DIST_DIR=str(dist)), contextlib.redirect_stdout(output):
                generator.main()
            expected_names = set(UNCHANGED_SHA256) | {'shy_sway', 'cheerful_bounce'}
            self.assertEqual(set(generator.GENERATORS), expected_names)
            expected_stdout = ''
            for name, recipe in generator.GENERATORS.items():
                payload = (motions / f'{name}.motion3.json').read_bytes()
                self.assertEqual(payload, (dist / f'{name}.motion3.json').read_bytes())
                if name in UNCHANGED_SHA256:
                    self.assertEqual(hashlib.sha256(payload).hexdigest(), UNCHANGED_SHA256[name], name)
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
