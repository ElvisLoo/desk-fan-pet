class FanPet {
    constructor() {
        this.isRunning = false;
        this.speed = 0;
        this.speedLevels = [0, 1, 2, 3];
        this.speedNames = ['停止', '低速', '中速', '高速'];
        this.mood = 50;
        this.battery = 80;
        this.batteryDrainInterval = null;
        
        this.initElements();
        this.bindEvents();
        this.updateDisplay();
        this.startBatteryDrain();
    }
    
    initElements() {
        this.pet = document.getElementById('pet');
        this.fanBlade = document.getElementById('fanBlade');
        this.toggleBtn = document.getElementById('toggleBtn');
        this.speedBtn = document.getElementById('speedBtn');
        this.petBtn = document.getElementById('petBtn');
        this.speedDisplay = document.getElementById('speedDisplay');
        this.moodDisplay = document.getElementById('moodDisplay');
        this.batteryLevel = document.getElementById('batteryLevel');
        this.windEffect = document.getElementById('windEffect');
    }
    
    bindEvents() {
        this.toggleBtn.addEventListener('click', () => this.toggleFan());
        this.speedBtn.addEventListener('click', () => this.changeSpeed());
        this.petBtn.addEventListener('click', () => this.petCharacter());
    }
    
    toggleFan() {
        if (!this.isRunning) {
            this.startFan();
        } else {
            this.stopFan();
        }
        this.updateDisplay();
    }
    
    startFan() {
        this.isRunning = true;
        this.speed = 1;
        this.fanBlade.classList.add('spinning');
        this.toggleBtn.textContent = '关闭风扇';
        this.toggleBtn.classList.add('active');
        this.createWindLines();
        this.updateMood(5);
    }
    
    stopFan() {
        this.isRunning = false;
        this.speed = 0;
        this.fanBlade.classList.remove('spinning', 'speed-fast', 'speed-slow');
        this.toggleBtn.textContent = '开启风扇';
        this.toggleBtn.classList.remove('active');
        this.removeWindLines();
    }
    
    changeSpeed() {
        if (!this.isRunning) {
            this.startFan();
        }
        
        const currentIndex = this.speedLevels.indexOf(this.speed);
        this.speed = this.speedLevels[(currentIndex + 1) % this.speedLevels.length];
        
        this.updateFanSpeed();
        this.updateDisplay();
        this.updateMood(10);
    }
    
    updateFanSpeed() {
        this.fanBlade.classList.remove('spinning', 'speed-fast', 'speed-slow');
        
        switch(this.speed) {
            case 1:
                this.fanBlade.classList.add('speed-slow');
                break;
            case 2:
                this.fanBlade.classList.add('spinning');
                break;
            case 3:
                this.fanBlade.classList.add('speed-fast');
                break;
        }
    }
    
    petCharacter() {
        this.updateMood(15);
        this.pet.classList.add('happy');
        
        setTimeout(() => {
            this.pet.classList.remove('happy');
        }, 2000);
    }
    
    updateMood(amount) {
        this.mood = Math.min(100, Math.max(0, this.mood + amount));
        
        if (this.mood > 70) {
            this.moodDisplay.textContent = '😄';
        } else if (this.mood > 40) {
            this.moodDisplay.textContent = '😊';
        } else if (this.mood > 20) {
            this.moodDisplay.textContent = '😐';
        } else {
            this.moodDisplay.textContent = '😢';
        }
    }
    
    updateDisplay() {
        this.speedDisplay.textContent = this.speedNames[this.speed];
        
        if (this.isRunning) {
            this.updateBattery();
        }
    }
    
    updateBattery() {
        const batteryWidth = (this.battery / 100) * 100;
        this.batteryLevel.style.width = batteryWidth + '%';
        
        if (this.battery < 20) {
            this.batteryLevel.style.background = 'linear-gradient(90deg, #f44336, #ef5350)';
        } else if (this.battery < 50) {
            this.batteryLevel.style.background = 'linear-gradient(90deg, #ff9800, #ffb74d)';
        } else {
            this.batteryLevel.style.background = 'linear-gradient(90deg, #4CAF50, #66BB6A)';
        }
        
        if (this.battery <= 0) {
            this.stopFan();
            alert('电量耗尽！请等待充电...');
        }
    }
    
    startBatteryDrain() {
        setInterval(() => {
            if (this.isRunning && this.battery > 0) {
                this.battery -= 1;
                this.updateDisplay();
            }
        }, 3000);
    }
    
    createWindLines() {
        this.windEffect.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const windLine = document.createElement('div');
            windLine.className = 'wind-line active';
            this.windEffect.appendChild(windLine);
        }
    }
    
    removeWindLines() {
        this.windEffect.innerHTML = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new FanPet();
});
