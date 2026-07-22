(function(){
  "use strict";

  var DOW_LETTERS = ['D','L','M','X','J','V','S'];
  var MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  var CAPACITY = 7;

  window.storage = {
    get: function(key){
      if (key === 'known_students') {
        return fetch('/api/known').then(function(res){
          if (!res.ok) throw new Error('No se pudo cargar la lista de alumnos');
          return res.json().then(function(data){ return { value: JSON.stringify(data.known || []) }; });
        });
      }
      return fetch('/api/day/' + encodeURIComponent(key)).then(function(res){
        if (!res.ok) throw new Error('No se pudo cargar el día');
        return res.json().then(function(data){ return { value: JSON.stringify(data || { blocks: {} }) }; });
      });
    },
    set: function(key, value){
      if (key === 'known_students') {
        var list = JSON.parse(value || '[]');
        return fetch('/api/known', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ known: list })
        }).then(function(res){
          if (!res.ok) throw new Error('No se pudo guardar la lista de alumnos');
          return { ok: true };
        });
      }
      var payload = JSON.parse(value || '{"blocks":{}}');
      return fetch('/api/day/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: key, data: payload })
      }).then(function(res){
        if (!res.ok) throw new Error('No se pudo guardar el día');
        return { ok: true };
      });
    }
  };

  function pad(n){ return n < 10 ? '0'+n : ''+n; }
  function dateKey(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function startOfDay(d){ var nd = new Date(d); nd.setHours(0,0,0,0); return nd; }
  function addDays(d,n){ var nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; }
  function sameDay(a,b){ return dateKey(a) === dateKey(b); }
  function getMonday(d){
    var nd = startOfDay(d);
    var day = nd.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    return addDays(nd, diff);
  }

  function blockDefsForDate(date){
    var day = date.getDay();
    if (day === 0) return [];
    var blocks = [];
    if (day >= 1 && day <= 5){
      blocks.push({id:'08-09', start:'8:00', end:'9:00', modality:'virtual'});
      blocks.push({id:'09-10', start:'9:00', end:'10:00', modality:'presencial'});
      blocks.push({id:'10-11', start:'10:00', end:'11:00', modality:'presencial'});
      blocks.push({id:'11-12', start:'11:00', end:'12:00', modality:'presencial'});
      blocks.push({id:'15-16', start:'15:00', end:'16:00', modality:'presencial'});
      blocks.push({id:'16-17', start:'16:00', end:'17:00', modality:'presencial'});
      blocks.push({id:'17-18', start:'17:00', end:'18:00', modality:'presencial'});
      blocks.push({id:'18-19', start:'18:00', end:'19:00', modality:'virtual'});
      blocks.push({id:'19-20', start:'19:00', end:'20:00', modality:'virtual'});
    } else if (day === 6){
      blocks.push({id:'09-10', start:'9:00', end:'10:00', modality:'presencial'});
      blocks.push({id:'10-11', start:'10:00', end:'11:00', modality:'presencial'});
      blocks.push({id:'11-12', start:'11:00', end:'12:00', modality:'presencial'});
    }
    return blocks;
  }

  function blockStartHour(b){ return parseInt(b.start.split(':')[0], 10); }

  function loadDayData(key){
    return window.storage.get(key, false).then(function(r){
      return r && r.value ? JSON.parse(r.value) : { blocks: {} };
    }).catch(function(){ return { blocks: {} }; });
  }
  function saveDayData(key, data){
    return window.storage.set(key, JSON.stringify(data), false).catch(function(e){
      console.error('Error al guardar', e);
      showToast('No se pudo guardar. Intentá de nuevo.');
    });
  }
  function loadKnown(){
    return window.storage.get('known_students', false).then(function(r){
      return r && r.value ? JSON.parse(r.value) : [];
    }).catch(function(){ return []; });
  }
  function saveKnown(list){
    return window.storage.set('known_students', JSON.stringify(list), false).catch(function(){});
  }
  function rememberStudent(name, subject){
    var lower = name.trim().toLowerCase();
    if (!lower) return;
    state.known = state.known.filter(function(k){ return k.name.toLowerCase() !== lower; });
    state.known.unshift({ name: name.trim(), subject: subject.trim() });
    if (state.known.length > 80) state.known = state.known.slice(0, 80);
    saveKnown(state.known);
    renderDatalist();
  }

  function uid(){ return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  var state = {
    selectedDate: startOfDay(new Date()),
    dayData: { blocks: {} },
    known: [],
    modal: { blockId: null, studentId: null }
  };

  var today = startOfDay(new Date());

  var dateMainEl = document.getElementById('dateMain');
  var dateCapEl = document.getElementById('dateCap');
  var themeToggle = document.getElementById('themeToggle');
  var spiralRow = document.getElementById('spiralRow');
  var tabsRow = document.getElementById('tabsRow');
  var bannerSlot = document.getElementById('bannerSlot');
  var blocksSlot = document.getElementById('blocksSlot');
  var overlay = document.getElementById('overlay');
  var toastEl = document.getElementById('toast');

  var fName = document.getElementById('fName');
  var fSubject = document.getElementById('fSubject');
  var fNotes = document.getElementById('fNotes');
  var modalTitle = document.getElementById('modalTitle');
  var modalSub = document.getElementById('modalSub');
  var deleteBtn = document.getElementById('deleteBtn');
  var knownNamesList = document.getElementById('knownNames');

  var toastTimer = null;
  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 2200);
  }

  function renderDatalist(){
    knownNamesList.innerHTML = state.known.map(function(k){
      return '<option value="' + escapeHtml(k.name) + '">';
    }).join('');
  }

  function escapeHtml(s){
    return (s || '').replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  function renderHeader(){
    var d = state.selectedDate;
    dateCapEl.textContent = sameDay(d, today) ? 'Hoy' : (DOW_LETTERS[d.getDay()] === 'D' ? 'Domingo' : 'Fecha seleccionada');
    dateMainEl.textContent = d.getDate() + ' de ' + MONTHS[d.getMonth()];
  }

  function renderWeek(){
    var monday = getMonday(state.selectedDate);
    spiralRow.innerHTML = '';
    tabsRow.innerHTML = '';

    var promises = [];
    for (var i = 0; i < 6; i++){
      spiralRow.innerHTML += '<div class="spiral-hole"></div>';
    }

    var frag = '';
    var dayDataCache = {};
    for (var i = 0; i < 6; i++){
      (function(i){
        var d = addDays(monday, i);
        var key = dateKey(d);
        promises.push(loadDayData(key).then(function(data){
          dayDataCache[i] = data;
        }));
      })(i);
    }

    Promise.all(promises).then(function(){
      var html = '';
      for (var i = 0; i < 6; i++){
        var d = addDays(monday, i);
        var isToday = sameDay(d, today);
        var isSelected = sameDay(d, state.selectedDate);
        var data = dayDataCache[i] || { blocks: {} };
        var hasStudents = Object.keys(data.blocks).some(function(bid){
          return (data.blocks[bid] || []).length > 0;
        });
        html += '<button class="tab' +
          (isToday ? ' is-today' : '') +
          (isSelected ? ' is-selected' : '') +
          (hasStudents ? ' has-students' : '') +
          '" data-idx="' + i + '">' +
          (isToday ? '<span class="stamp">HOY</span>' : '') +
          '<span class="d-letter">' + DOW_LETTERS[d.getDay()] + '</span>' +
          '<span class="d-num">' + d.getDate() + '</span>' +
          '<span class="dot-mark"></span>' +
          '</button>';
      }
      tabsRow.innerHTML = html;
      Array.prototype.forEach.call(tabsRow.querySelectorAll('.tab'), function(btn){
        btn.addEventListener('click', function(){
          var idx = parseInt(btn.getAttribute('data-idx'), 10);
          goToDate(addDays(monday, idx));
        });
      });
    });
  }

  function renderBanner(){
    var isToday = sameDay(state.selectedDate, today);
    if (!isToday){
      bannerSlot.innerHTML = '';
      return;
    }
    var defs = blockDefsForDate(state.selectedDate);
    var totalStudents = 0;
    var blocksWithStudents = 0;
    defs.forEach(function(b){
      var list = state.dayData.blocks[b.id] || [];
      if (list.length){ blocksWithStudents++; totalStudents += list.length; }
    });

    if (defs.length === 0){
      bannerSlot.innerHTML = '';
      return;
    }

    var msg;
    if (totalStudents === 0){
      msg = 'Todavía no anotaste alumnos para hoy.';
    } else {
      msg = 'Hoy recibís ' + totalStudents + (totalStudents === 1 ? ' alumno' : ' alumnos') +
        ' en ' + blocksWithStudents + (blocksWithStudents === 1 ? ' bloque' : ' bloques') + '.';
    }

    bannerSlot.innerHTML =
      '<div class="banner">' +
        '<span class="bell">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 8a6 6 0 0112 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z" stroke="#D9A544" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 17a2.5 2.5 0 005 0" stroke="#D9A544" stroke-width="1.8" stroke-linecap="round"/></svg>' +
        '</span>' +
        '<div>' +
          '<strong>Recordatorio del día</strong>' +
          '<p>' + msg + '</p>' +
        '</div>' +
      '</div>';
  }

  function nowMinutes(){
    var n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }
  function toMinutes(hhmm){
    var parts = hhmm.split(':');
    return parseInt(parts[0],10) * 60 + parseInt(parts[1],10);
  }

  function renderBlocks(){
    var defs = blockDefsForDate(state.selectedDate);
    if (defs.length === 0){
      blocksSlot.innerHTML = '<div class="no-class"><span class="big">Sin clases este día</span>Los domingos no hay bloques programados.</div>';
      return;
    }

    var isToday = sameDay(state.selectedDate, today);
    var nowM = nowMinutes();

    var html = '';
    defs.forEach(function(b){
      var list = state.dayData.blocks[b.id] || [];
      var count = list.length;
      var isFull = count >= CAPACITY;
      var isCurrent = isToday && nowM >= toMinutes(b.start) && nowM < toMinutes(b.end);

      var dots = '';
      for (var i = 0; i < CAPACITY; i++){
        dots += '<span class="' + (i < count ? (isFull ? 'filled full-mark' : 'filled') : '') + '"></span>';
      }

      var chips = list.map(function(s){
        return '<button class="chip" data-block="' + b.id + '" data-student="' + s.id + '">' +
          '<span class="name">' + escapeHtml(s.name) + '</span>' +
          (s.subject ? '<span class="subj">· ' + escapeHtml(s.subject) + '</span>' : '') +
          '</button>';
      }).join('');

      html += '<div class="block-card ' + b.modality + (isCurrent ? ' now-current' : '') + '">' +
        '<div class="block-time">' + b.start + '<br>' + b.end + '</div>' +
        '<div class="block-body">' +
          '<div class="block-head">' +
            '<span class="modality-tag">' + (b.modality === 'presencial' ? 'Presencial' : 'Virtual') + '</span>' +
            '<span class="capacity"><span class="cap-dots">' + dots + '</span>' +
              '<span class="cap-text' + (isFull ? ' is-full' : '') + '">' + count + '/' + CAPACITY + '</span></span>' +
          '</div>' +
          (chips ? '<div class="student-list">' + chips + '</div>' : '') +
          '<button class="add-student-btn" data-block="' + b.id + '" ' + (isFull ? 'disabled' : '') + '>' +
            (isFull ? 'Cupo completo' : '+ Agregar alumno') +
          '</button>' +
        '</div>' +
      '</div>';
    });

    blocksSlot.innerHTML = html;

    Array.prototype.forEach.call(blocksSlot.querySelectorAll('.add-student-btn'), function(btn){
      btn.addEventListener('click', function(){
        if (btn.disabled) return;
        openModal(btn.getAttribute('data-block'), null);
      });
    });
    Array.prototype.forEach.call(blocksSlot.querySelectorAll('.chip'), function(chip){
      chip.addEventListener('click', function(){
        openModal(chip.getAttribute('data-block'), chip.getAttribute('data-student'));
      });
    });
  }

  function applyTheme(){
    var isDark = localStorage.getItem('agenda-theme') === 'dark';
    document.body.classList.toggle('dark-mode', isDark);
    if (themeToggle) {
      themeToggle.textContent = isDark ? '☀️' : '🌙';
      themeToggle.setAttribute('aria-label', isDark ? 'Activar modo claro' : 'Cambiar a modo oscuro');
    }
  }

  function toggleTheme(){
    var isDark = document.body.classList.contains('dark-mode');
    var next = isDark ? 'light' : 'dark';
    localStorage.setItem('agenda-theme', next);
    applyTheme();
  }

  function render(){
    renderHeader();
    renderWeek();
    renderBanner();
    renderBlocks();
  }

  function goToDate(d){
    state.selectedDate = startOfDay(d);
    loadDayData(dateKey(state.selectedDate)).then(function(data){
      state.dayData = data;
      render();
    });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
  }

  document.getElementById('prevDayBtn').addEventListener('click', function(){
    goToDate(addDays(state.selectedDate, -1));
  });
  document.getElementById('nextDayBtn').addEventListener('click', function(){
    goToDate(addDays(state.selectedDate, 1));
  });
  document.getElementById('todayBtn').addEventListener('click', function(){
    goToDate(today);
  });
  document.getElementById('prevWeekBtn').addEventListener('click', function(){
    goToDate(addDays(state.selectedDate, -7));
  });
  document.getElementById('nextWeekBtn').addEventListener('click', function(){
    goToDate(addDays(state.selectedDate, 7));
  });

  var hiddenDateInput = document.getElementById('hiddenDateInput');
  document.getElementById('dateLabelBtn').addEventListener('click', function(){
    hiddenDateInput.value = dateKey(state.selectedDate);
    hiddenDateInput.showPicker ? hiddenDateInput.showPicker() : hiddenDateInput.click();
  });
  hiddenDateInput.addEventListener('change', function(){
    if (hiddenDateInput.value){
      var parts = hiddenDateInput.value.split('-');
      goToDate(new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10)));
    }
  });

  function openModal(blockId, studentId){
    state.modal.blockId = blockId;
    state.modal.studentId = studentId;
    var defs = blockDefsForDate(state.selectedDate);
    var def = defs.filter(function(b){ return b.id === blockId; })[0];
    var list = state.dayData.blocks[blockId] || [];

    if (studentId){
      var student = list.filter(function(s){ return s.id === studentId; })[0] || {name:'',subject:'',notes:''};
      modalTitle.textContent = 'Editar alumno';
      fName.value = student.name || '';
      fSubject.value = student.subject || '';
      fNotes.value = student.notes || '';
      deleteBtn.style.display = 'block';
    } else {
      modalTitle.textContent = 'Agregar alumno';
      fName.value = '';
      fSubject.value = '';
      fNotes.value = '';
      deleteBtn.style.display = 'none';
    }
    modalSub.textContent = def ? (def.modality === 'presencial' ? 'Presencial' : 'Virtual') + ' · ' + def.start + ' a ' + def.end : '';

    overlay.classList.add('open');
    setTimeout(function(){ fName.focus(); }, 50);
  }

  function closeModal(){
    overlay.classList.remove('open');
  }

  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e){
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
  });

  document.getElementById('saveBtn').addEventListener('click', function(){
    var name = fName.value.trim();
    if (!name){
      fName.focus();
      return;
    }
    var subject = fSubject.value.trim();
    var notes = fNotes.value.trim();
    var blockId = state.modal.blockId;
    if (!state.dayData.blocks[blockId]) state.dayData.blocks[blockId] = [];
    var list = state.dayData.blocks[blockId];

    if (state.modal.studentId){
      var idx = list.findIndex(function(s){ return s.id === state.modal.studentId; });
      if (idx > -1){
        list[idx].name = name;
        list[idx].subject = subject;
        list[idx].notes = notes;
      }
    } else {
      if (list.length >= CAPACITY){
        showToast('Ese bloque ya tiene los 7 cupos ocupados.');
        return;
      }
      list.push({ id: uid(), name: name, subject: subject, notes: notes });
    }

    saveDayData(dateKey(state.selectedDate), state.dayData).then(function(){
      rememberStudent(name, subject);
      closeModal();
      renderWeek();
      renderBanner();
      renderBlocks();
      showToast('Guardado.');
    });
  });

  deleteBtn.addEventListener('click', function(){
    var blockId = state.modal.blockId;
    var list = state.dayData.blocks[blockId] || [];
    state.dayData.blocks[blockId] = list.filter(function(s){ return s.id !== state.modal.studentId; });
    saveDayData(dateKey(state.selectedDate), state.dayData).then(function(){
      closeModal();
      renderWeek();
      renderBanner();
      renderBlocks();
      showToast('Alumno quitado.');
    });
  });

  function init(){
    applyTheme();
    loadKnown().then(function(list){
      state.known = list;
      renderDatalist();
      return loadDayData(dateKey(state.selectedDate));
    }).then(function(data){
      state.dayData = data;
      render();
    });
  }

  init();
})();
