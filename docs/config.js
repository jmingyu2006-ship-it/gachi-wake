// 공유 서버 설정
// 비워 두면 다른 사람 창문은 예시 데이터로 보여요.
// anon 키는 웹에 공개돼도 되는 키예요 (서버 규칙상 쓰기 1건·합계 읽기만 가능). service_role 키는 절대 넣지 마세요.
window.GACHI_CONFIG = {
  supabaseUrl: 'https://vwhomuyxezmrogsvnkbc.supabase.co',
  // 개인정보 처리방침·이용약관에 보일 문의 이메일 (비워 두면 GitHub 문의 게시판으로 안내)
  contact: '',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3aG9tdXl4ZXptcm9nc3Zua2JjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwNTMwOTksImV4cCI6MjEwOTYyOTA5OX0.sG5AiS87_6Kj6wX-Nd9OMJUCzPg6_CKzj_6Ppzsofmk'
};
