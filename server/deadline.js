function withDeadline(promise, timeoutMs, code = 'TIMEOUT') {
  const delay=Math.max(1,Number(timeoutMs)||1);
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      const error=new Error('Operation timed out.');
      error.code=code;
      reject(error);
    },delay);
  });
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}

module.exports={withDeadline};
