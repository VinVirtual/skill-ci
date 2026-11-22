# Deliberately unsafe: a fixture for skill-ci's footgun check.
import os
import subprocess
import yaml


def run(cmd, path):
    subprocess.run(cmd, shell=True)
    os.system("ls " + path)
    with open(path) as f:
        return yaml.load(f)
