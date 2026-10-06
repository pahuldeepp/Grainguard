import tempfile
import unittest
from pathlib import Path
from local_controls import initialize_controls

class ControlsSetupTests(unittest.TestCase):
    def test_initial_configuration_is_private_and_operator_settings_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'controls.json'
            self.assertTrue(initialize_controls(path,'example'))
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            path.write_text('operator settings')
            self.assertFalse(initialize_controls(path,'replacement'))
            self.assertEqual(path.read_text(),'operator settings')
            link=Path(directory)/'link'; link.symlink_to(path)
            self.assertFalse(initialize_controls(link,'replacement'))
            self.assertEqual(path.read_text(),'operator settings')
