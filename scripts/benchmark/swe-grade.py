#!/usr/bin/env python3
"""Stdlib-only, frozen SWE-bench grading; does not execute the official CLI."""
import argparse
import hashlib
import importlib
import json
from pathlib import Path
import sys
import types

COMMIT = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'
SOURCE_HASHES = {
    'swebench/types.py': '558b6e7193306c304f9847a8a83dcab6a03ee333f6d51e61152e8821f89e0725',
    'swebench/harness/constants/__init__.py': '8895ab5313d874349c4b07bd223bb9eb00acaee377b432e67cc7ad840341e79b',
    'swebench/harness/log_parsers/python.py': 'cd56156414f8327221e525665ace9b184f7d73e83b272d9eb3f545fb17c2d9bc',
    'swebench/harness/log_parsers/__init__.py': '2227a8696ce43a4266dccfa434374afaff43df6bd0b1769f431f5efe76500c14',
    'swebench/harness/infra_failure.py': '72eaca5e8f76390ff9ac1d2d606f5390820b88efe6eed56efed8ff520c593eac',
    'swebench/harness/grading.py': 'a095273010175001a6779e365b3b77abb8657c7ac2e4f80b4bc360faa6f09483',
}


REPO_PARSERS = {
    'sqlfluff/sqlfluff': 'parse_log_sqlfluff',
    'django/django': 'parse_log_django',
    'matplotlib/matplotlib': 'parse_log_matplotlib',
    'sphinx-doc/sphinx': 'parse_log_sphinx',
    'sympy/sympy': 'parse_log_sympy',
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_grader(root):
    root = Path(root).resolve(strict=True)
    for name, expected in SOURCE_HASHES.items():
        if sha(root / name) != expected:
            raise ValueError('Frozen harness source mismatch: ' + name)
    if any(name == 'swebench' or name.startswith('swebench.') for name in sys.modules):
        raise RuntimeError('SWE-bench already imported; use a fresh scoring process')
    # Only namespace bootstraps are substituted. Source modules below are loaded
    # unchanged through normal import machinery after all hashes are checked.
    for name in ('swebench', 'swebench.harness', 'swebench.harness.log_parsers'):
        module = types.ModuleType(name)
        module.__path__ = [str(root / name.replace('.', '/'))]
        sys.modules[name] = module
    definitions = importlib.import_module('swebench.types')
    python_parser = importlib.import_module('swebench.harness.log_parsers.python')
    registry = {}
    for repo, parser_name in REPO_PARSERS.items():
        parser = getattr(python_parser, parser_name)
        if python_parser.MAP_REPO_TO_PARSER_PY.get(repo) is not parser:
            raise ValueError('Frozen repository/parser mapping mismatch: ' + repo)
        registry[parser_name] = parser
    sys.modules['swebench.harness.log_parsers'].PARSER_REGISTRY = registry
    grading = importlib.import_module('swebench.harness.grading')
    return definitions.TestSpec, grading.get_eval_report


def test_names(value):
    result = json.loads(value) if isinstance(value, str) else value
    if not isinstance(result, list) or not all(isinstance(item, str) and item for item in result):
        raise ValueError('Expected a list of test identifiers')
    return result


def grade(args):
    task = json.loads(Path(args.task_file).read_text())
    if task.get('repo') not in REPO_PARSERS or task.get('log_parser') != REPO_PARSERS[task['repo']]:
        raise ValueError('Only exact allowlisted frozen repository/Python parser profiles are allowed')
    if task.get('eval_type') != 'pass_and_fail':
        raise ValueError('Only pass_and_fail evaluation is allowed')
    TestSpec, get_eval_report = load_grader(args.harness_root)
    spec = TestSpec(instance_id=task['instance_id'], image=task['image'],
                    eval_script_list=[], repo=task['repo'], version=task['version'],
                    FAIL_TO_PASS=test_names(task['FAIL_TO_PASS']),
                    PASS_TO_PASS=test_names(task['PASS_TO_PASS']),
                    log_parser=task['log_parser'], eval_type=task['eval_type'])
    prediction = {'instance_id': spec.instance_id, 'model_name_or_path': 'dsh-free-context-canary',
                  'model_patch': Path(args.patch_file).read_text()}
    report = get_eval_report(spec, prediction, str(args.log_file), include_tests_status=True)
    return {
        'report': report,
        'provenance': {
            'harness_commit': COMMIT,
            'source_sha256': SOURCE_HASHES,
            'task_sha256': sha(args.task_file), 'patch_sha256': sha(args.patch_file),
            'log_sha256': sha(args.log_file), 'log_parser': spec.log_parser,
            'loader': 'stdlib namespace bootstrap; unchanged official get_eval_report and allowlisted Python parser; not full official CLI',
            'fail_to_pass_count': len(spec.FAIL_TO_PASS), 'pass_to_pass_count': len(spec.PASS_TO_PASS),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('harness-root', 'task-file', 'patch-file', 'log-file', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    result = grade(args)
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
