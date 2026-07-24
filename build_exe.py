from PyInstaller.__main__ import run

if __name__ == '__main__':
    args = [
        'pet_fan.py',
        '--onefile',
        '--windowed',
        '--name=DeskFanPet',
        '--icon=NONE',
        '--clean',
        '--noconfirm'
    ]
    run(args)
