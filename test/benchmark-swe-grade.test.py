"""No model calls: exercise frozen official grading using synthetic logs."""
import json
import importlib.util
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / '.omx/benchmarks/public-canary-20261029/harness-source'
SCRIPT = ROOT / 'scripts/benchmark/swe-grade.py'


class GradingTests(unittest.TestCase):
    def score(self, body, parser='parse_log_sqlfluff', markers=True, pass_to_pass=None,
              repo='sqlfluff/sqlfluff', fail_to_pass=None, rejected=False):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            task = {'instance_id': 'synthetic', 'repo': repo, 'image': 'synthetic', 'version': '0.12',
                    'log_parser': parser, 'eval_type': 'pass_and_fail', 'FAIL_TO_PASS': fail_to_pass if fail_to_pass is not None else ['test_a', 'test_b'], 'PASS_TO_PASS': pass_to_pass or []}
            (directory / 'task.json').write_text(json.dumps(task))
            (directory / 'patch').write_text('synthetic patch')
            log = ('>>>>> Start Test Output\n' + body + '\n>>>>> End Test Output\n>>>>> Test Exit Code: 0\n') if markers else body
            (directory / 'log').write_text(log)
            run = subprocess.run([sys.executable, str(SCRIPT), '--harness-root', str(HARNESS), '--task-file', str(directory / 'task.json'),
                                  '--patch-file', str(directory / 'patch'), '--log-file', str(directory / 'log'), '--output', str(directory / 'result.json')], capture_output=True, text=True)
            if rejected:
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse((directory / 'result.json').exists())
                self.assertIn('Only exact allowlisted', run.stderr)
                return None
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads((directory / 'result.json').read_text())
            self.assertEqual(len(result['provenance']['source_sha256']), 6)
            self.assertEqual(result['provenance']['log_parser'], parser)
            self.assertEqual(result['provenance']['pass_to_pass_count'], len(pass_to_pass or []))
            return result['report']['synthetic']

    def test_source_drift_and_missing_rejected(self):
        spec = importlib.util.spec_from_file_location('swe_grade', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in module.SOURCE_HASHES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(HARNESS / name, target)
            target = root / 'swebench/harness/grading.py'
            target.write_text(target.read_text() + '\n# drift\n')
            with self.assertRaises(ValueError):
                module.load_grader(root)
            target.unlink()
            with self.assertRaises(FileNotFoundError):
                module.load_grader(root)

    def test_all_pass(self):
        self.assertTrue(self.score('PASSED test_a\nPASSED test_b')['resolved'])

    def test_missing_markers(self):
        self.assertFalse(self.score('PASSED test_a\nPASSED test_b', markers=False)['resolved'])

    def test_missing_required_test(self):
        self.assertFalse(self.score('PASSED test_a')['resolved'])

    def test_failure_despite_zero_script_exit(self):
        self.assertFalse(self.score('PASSED test_a\nFAILED test_b')['resolved'])

    def test_pass_to_pass_regression_blocks_resolution(self):
        result = self.score('PASSED test_a\nPASSED test_b\nFAILED test_existing', pass_to_pass=['test_existing'])
        self.assertFalse(result['resolved'])
        self.assertIn('test_existing', result['tests_status']['PASS_TO_PASS']['failure'])

    def test_parser_rejected(self):
        self.score('PASSED test_a', parser='parse_log_unapproved', rejected=True)

    def test_exact_repo_parser_pair_required(self):
        for repo, parser in [('django/django', 'parse_log_sqlfluff'),
                             ('sqlfluff/sqlfluff', 'parse_log_django'),
                             ('unknown/project', 'parse_log_django'),
                             ('sphinx-doc/sphinx', 'parse_log_pytest_v2')]:
            with self.subTest(repo=repo, parser=parser):
                self.score('PASSED test_a', repo=repo, parser=parser, rejected=True)

    def test_added_parsers_require_f2p_and_p2p_success(self):
        profiles = [
            ('django/django', 'parse_log_django', 'test_a ... ok\ntest_b ... ok',
             'test_existing ... ok', 'test_existing ... FAIL'),
            ('matplotlib/matplotlib', 'parse_log_matplotlib', 'PASSED test_a\nPASSED test_b',
             'PASSED test_existing', 'FAILED test_existing - AssertionError'),
            ('sphinx-doc/sphinx', 'parse_log_sphinx', 'test_a PASSED\ntest_b PASSED',
             'test_existing PASSED', 'test_existing FAILED'),
            ('sympy/sympy', 'parse_log_sympy', 'test_a ok\ntest_b ok',
             'test_existing ok', 'test_existing F'),
        ]
        for repo, parser, fixed, existing_pass, existing_fail in profiles:
            with self.subTest(repo=repo):
                options = dict(repo=repo, parser=parser, pass_to_pass=['test_existing'])
                self.assertTrue(self.score(fixed + '\n' + existing_pass, **options)['resolved'])
                for existing in [existing_fail, '']:
                    result = self.score(fixed + '\n' + existing, **options)
                    self.assertFalse(result['resolved'])
                    self.assertIn('test_existing', result['tests_status']['PASS_TO_PASS']['failure'])
                self.assertFalse(self.score(existing_pass, **options)['resolved'])
                self.assertFalse(self.score(fixed + '\n' + existing_pass, markers=False, **options)['resolved'])

    def test_matplotlib_normalizes_mouse_button_identifiers(self):
        result = self.score('PASSED test_event[MouseButton.LEFT]\nPASSED test_event[MouseButton.RIGHT]',
                            repo='matplotlib/matplotlib', parser='parse_log_matplotlib',
                            fail_to_pass=['test_event[1]'], pass_to_pass=['test_event[3]'])
        self.assertTrue(result['resolved'])

    def test_django_multiline_output_and_sympy_error(self):
        self.assertTrue(self.score('test_a ... extra output\nok\ntest_b ... OK',
                                   repo='django/django', parser='parse_log_django')['resolved'])
        self.assertFalse(self.score('test_a ok\ntest_b E',
                                    repo='sympy/sympy', parser='parse_log_sympy')['resolved'])


if __name__ == '__main__':
    unittest.main()
