const fanBlades = document.getElementById('fanBlades');
const powerBtn = document.getElementById('powerBtn');
const speedBtn = document.getElementById('speedBtn');
const petBtn = document.getElementById('petBtn');
const speedLabel = document.getElementById('speedLabel');
const batteryBar = document.getElementById('batteryBar');

const state = {
    running: false,
    speed: 0,
    speeds: [
        { name: '停止', cls: '' },
        { name: '低速', cls: 'speed-low' },
        { name: '中速', cls: 'spinning' },
        { name: '高速', cls: 'speed-high' }
    ],
    mood: 50,
    battery: 80,
};

function updateFan() {
    fanBlades.className = 'fan-blades';
    if (state.running && state.speed > 0) {
        fanBlades.classList.add(state.speeds[state.speed].cls);
    }
}

function updateMoodDisplay() {
    const mouth = document.getElementById('mouth');
    const wrapper = document.querySelector('.pet-wrapper');
    
    if (state.mood > 70) {
        mouth.style.height = '14px';
        wrapper.classList.add('happy');
    } else if (state.mood > 40) {
        mouth.style.height = '10px';
        wrapper.classList.remove('happy');
    } else {
        mouth.style.height = '6px';
        wrapper.classList.remove('happy');
    }
}

function updateBattery() {
    const level = batteryBar.querySelector('.battery-level') || createBatteryLevel();
    level.style.width = state.battery + '%';
    
    if (state.battery < 20) {
        level.style.background = 'linear-gradient(90deg, #f44336, #ef5350)';
    } else if (state.battery < 50) {
        level.style.background = 'linear-gradient(90deg, #ff9800, #ffb74d)';
    } else {
        level.style.background = 'linear-gradient(90deg, #4CAF50, #66BB6A)';
    }
}

function createBatteryLevel() {
    const div = document.createElement('div');
    div.className = 'battery-level';
    batteryBar.appendChild(div);
    return div;
}

powerBtn.addEventListener('click', () => {
    state.running = !state.running;
    if (state.running && state.speed === 0) {
        state.speed = 1;
    }
    if (!state.running) {
        state.speed = 0;
    }
    powerBtn.classList.toggle('active', state.running);
    speedLabel.textContent = state.running ? state.speeds[state.speed].name : '停止';
    updateFan();
});

speedBtn.addEventListener('click', () => {
    if (!state.running) {
        state.running = true;
        state.speed = 1;
        powerBtn.classList.add('active');
    } else {
        state.speed = (state.speed + 1) % state.speeds.length;
    }
    speedLabel.textContent = state.speeds[state.speed].name;
    updateFan();
});

petBtn.addEventListener('click', () => {
    state.mood = Math.min(100, state.mood + 15);
    updateMoodDisplay();
    petBtn.style.transform = 'scale(1.3)';
    setTimeout(() => { petBtn.style.transform = ''; }, 200);
});

setInterval(() => {
    if (state.running && state.battery > 0) {
        state.battery = Math.max(0, state.battery - 1);
        updateBattery();
    }
}, 3000);

updateMoodDisplay();
updateBattery();
