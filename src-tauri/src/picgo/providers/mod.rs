//! 各图床实现的汇总：每个图床一个文件，这里只做子模块声明与统一 re-export。

pub(crate) mod aliyun;
pub(crate) mod github;
pub(crate) mod imgur;
pub(crate) mod qiniu;
pub(crate) mod smms;
pub(crate) mod tcyun;
pub(crate) mod upyun;

pub(crate) use aliyun::upload_aliyun;
pub(crate) use github::upload_github;
pub(crate) use imgur::upload_imgur;
pub(crate) use qiniu::upload_qiniu;
pub(crate) use smms::upload_smms;
pub(crate) use tcyun::upload_tcyun;
pub(crate) use upyun::upload_upyun;
